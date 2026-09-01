// 把命令调用的失败映射成一条 HTTP 失败响应。
// ---------------------------------------------------------------------------
// 【本模块管的是两类失败，别把它们混成一类】
//   · **分发失败**（`unknown-command` / `unimplemented`）：请求根本没到达任何 handler。
//     命令名不存在 → 404，登记了但本次装配没实现 → 501。这是「这条路由回答不了你」。
//   · **命令自身失败**：handler 跑了、按设计拒绝了（或真出错了）。一律 502，见下。
// 不属于本模块的第三类是「外壳自己坏了」——回执序列化不出去之类。那种由 `requestRouter.ts` 的
// 外层 try/catch 收成 500，`invokeRoute.ts` 因此**只把 `invoke()` 那一次调用**放进 try 里。
// 这条分界线是本模块存在的全部意义：改之前，命令自身失败也落进那个 500，于是
//   ① MCP 的结构化失败丢了——客户端对 stdio 桥只认结构化信号、一个字都不读 message，什么都
//      拿不到就落到「可重试」的默认，于是一条**根本不存在的命令**（`command_spawn_failed`，
//      在桌面宿主上是永久失败）在 server 宿主上被判成临时失败，无限退避重连；
//   ② 各域写好的那句话也丢了——SQL 语法错、游标非法、路径越界，到客户端全变成一句
//      「本地服务返回了非预期的错误响应（HTTP 500）」，而桌面宿主上它们是原样到达的。
//
// 【为什么命令自身失败一律 502，而不按域分状态码】
// 这条路由的调用方是 `apps/web/src/host/serverInvoke.ts` 的 `httpInvoke`，它对外的契约是
// **和 Tauri 的 invoke 一样吐一个字符串**——状态码在那一步就被折掉了，分档对它没有任何价值。
// 唯一读结构的调用方是 C4 的 `serverMcpCommands.ts`，而它的判据恰恰是「502 的 `error` 字段就是
// kind」（`MCP_COMMAND_FAILURE_STATUS`）。再给别的域各配一张状态码表，等于把「给 MCP 开特例」
// 做了 N 遍，还会让同一次失败在两条路由上有两种状态码。
//
// 【`error` 字段：转发域自己的标识，没有就说没有】
// 判别用**字段**不用 `instanceof`，也不用文案——M6 在 model 域立下的规矩，理由逐字相同：错误要
// 跨 HTTP 序列化（今天 apps/server 与 host-node 同进程，sidecar 那条路上原型没了，只有字段还在），
// 而文案是给人看的对外契约，按它分支等于给同一份契约立第二个权威。
// 各域实际有什么标识，本模块只转发、不发明：
//   · mcp   → `McpCommandError.kind`（开放取值，见 host-node 的 `readMcpCommandErrorKind`）
//   · model → `ModelRequestError.reason`（闭合枚举）
//   · history → `AgentHistoryError.code`（闭合枚举，见 core 的 `isAgentHistoryErrorCode`）
//   · workspace / shell / config / sqlite → **没有**。这三百多个抛出点是等价移植 Rust 侧
//     `Err(String)` 的产物，那边同样只有一句话。所以它们统一落 `command_failed`。
// 刻意**不**按命令名推一个 `<domain>_command_failed` 出来：调用方本来就知道自己调的是哪条命令，
// 那个前缀不带新信息，却会造出一个 host-node 从未声明过的标识——本模块转发标识，不生产标识。
//
// 【`verdict` 字段：同一条纪律的第二样东西】（C5）
// mcp 域还给出「这次失败原样重试还有没有意义」。判定留在 host-node（`mcp/failureKinds.ts`：输入
// 只有 kind，一个字都不读 message，因为 message 里嵌着对端撰写的文本），本模块只把结论**原样**
// 放进信封。客户端从此不再自己维护一张 kind → 永久/暂时 的表——那张表靠人记得两边一起改，漏一条
// 的症状是没有症状：新 kind 落到「可重试」的默认，一个永远起不来的服务被无限退避重连。
// 与 `error` 字段一样只转发不生产：没给出裁决的域（model / history / workspace / shell / config / sqlite）
// 这个字段就不存在，客户端拿不到就退到可重试的安全侧。
//
// 【message 与 reason 一样按字段读】
// `error instanceof Error` 在序列化之后不成立（`McpCommandError.toJSON()` 的产物是普通对象），
// 而 message 恰恰是这类失败唯一保得住的人类可读信息。所以读 `.message` 字段而不是判类型，
// 与上面两个 reason/kind 读取面同一条纪律。文案本身直接透传 host-node 写好的那句，不在这里
// 另组一遍——两处各写一份中文，改一处就会和另一处漂移。

import {
  readMcpCommandErrorKind,
  readMcpFailureVerdict,
  readModelRequestErrorReason,
  type McpFailureVerdict,
  type NodeHostCommandErrorReason,
} from '@einfach-agent/host-node'
import { isAgentHistoryErrorCode, type AgentHistoryErrorCode } from '@einfach-agent/core/history'

export interface InvokeRouteErrorReply {
  readonly statusCode: number
  readonly error: string
  readonly message: string
  /** 域给出的重试裁决；没有的域为 `undefined`，那时信封里不出现这个键。 */
  readonly verdict?: McpFailureVerdict
}

/**
 * 「命令自己失败了」的状态码。
 *
 * 与 `apps/web/src/mcp/serverMcpCommands.ts` 的 `MCP_COMMAND_FAILURE_STATUS` 是同一个数——那头
 * 靠它把 `error` 字段认成 `McpCommandError.kind`。两边分叉的症状是**没有症状**：kind 恒为
 * undefined，全部 MCP 失败退回「可重试」，无限重连。`invokeRouteFailure.test.ts` 机械盯住这一条。
 */
export const COMMAND_FAILURE_STATUS = 502

/** 域没给出结构化标识时的稳定 `error` 码。 */
export const UNCLASSIFIED_COMMAND_FAILURE = 'command_failed'

/** 抛出物连一句话都没有时的兜底，好过把一个未知值字符串化后发出去。 */
const FALLBACK_MESSAGE = '命令执行失败。'

/**
 * 分发失败 → (状态码, 机器可读的 error 码)。**穷举**：`Record<NodeHostCommandErrorReason, …>`
 * 让 host-node 那头新增一类分发失败时，这里当场是编译错误，而不是运行时静默落进命令失败那一支。
 */
const DISPATCH_REPLY: Record<NodeHostCommandErrorReason, { statusCode: number, error: string }> = {
  'unknown-command': { statusCode: 404, error: 'unknown_command' },
  unimplemented: { statusCode: 501, error: 'command_not_implemented' },
}

/**
 * 只看 `reason` 字段。用 `Object.hasOwn` 而不是 `in`：`in` 会走原型链，一个 reason 恰好叫
 * `constructor` 的抛出物就能冒充成分发失败。
 */
function readDispatchReason(error: unknown): NodeHostCommandErrorReason | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const reason = (error as { reason?: unknown }).reason
  return typeof reason === 'string' && Object.hasOwn(DISPATCH_REPLY, reason)
    ? (reason as NodeHostCommandErrorReason)
    : undefined
}

function readAgentHistoryErrorCode(error: unknown): AgentHistoryErrorCode | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return isAgentHistoryErrorCode(code) ? code : undefined
}

/**
 * 域自己的标识，取不到就说取不到。读取面的合法取值集合互不相交，先后无所谓。
 */
function commandFailureCode(error: unknown): string {
  return readAgentHistoryErrorCode(error)
    ?? readMcpCommandErrorKind(error)
    ?? readModelRequestErrorReason(error)
    ?? UNCLASSIFIED_COMMAND_FAILURE
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string' && error.trim().length > 0) return error
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim().length > 0) return message
  }
  return FALLBACK_MESSAGE
}

export function mapInvokeRouteError(error: unknown): InvokeRouteErrorReply {
  const message = errorMessage(error)
  const dispatch = readDispatchReason(error)
  // 分发失败不带裁决：命令根本没跑，「重试有没有意义」是命令自己才回答得了的问题。
  if (dispatch !== undefined) return { ...DISPATCH_REPLY[dispatch], message }
  const verdict = readMcpFailureVerdict(error)
  return {
    statusCode: COMMAND_FAILURE_STATUS,
    error: commandFailureCode(error),
    message,
    ...(verdict === undefined ? {} : { verdict }),
  }
}
