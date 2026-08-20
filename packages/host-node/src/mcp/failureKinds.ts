// MCP 命令失败的分类表：kind →「原样重试还有没有意义」。全仓唯一一份。
// ---------------------------------------------------------------------------
// 【为什么这张表只能在铸造 kind 的这一侧】
// kind 是 host-node 在每个抛出点自己写下的字面量，对端一个字都插不进来；message 不是——`rpc_error`
// 那句话冒号之后整段是 MCP server 写的，`protocol_error` 里内联着对端的 cursor 与 protocolVersion。
// 所以「这次失败是不是永久的」只能由本表回答，而本表的输入**只有 kind**。
//
// 客户端（`tools/mcp/src/failureClassification.ts`）从前有一张同样的表，靠人记得两边一起改：
// 后端新增一个永久失败的 kind 而客户端漏登记，症状是**没有症状**——那个 kind 落到「可重试」的默认，
// 于是一个永远起不来的服务被无限退避重连（1→2→4→8→16→30s，六次约 61 秒，预算耗尽后同一个失败
// 照样浮上来，只是晚了一分钟）。现在裁决随错误一起走：`apps/server/src/invokeRouteError.ts` 把它
// 放进 `/api/invoke/:command` 的失败信封，客户端只读不判。后端新增/改名 kind，客户端不用动。
//
// 【铁律：永久结论只能来自对端不参与撰写的信号】
// 本表从不读 message。让文本参与判定，一台健康的 server 回一句 "must not be empty" 就能把自己判成
// 永久失败、停掉全部重连。`failureKinds.test.ts` 用「同一个 kind 配一堆互相矛盾的 message，裁决必须
// 逐字相同」钉住这一条。
//
// 【为什么 kind 在这里闭合、在 readMcpCommandErrorKind 那边仍是开放 string】
// 两侧管的是两件事。**铸造**面闭合：`KIND_VERDICT` 是 `Record<McpFailureKind, …>`，新增一个 kind
// 却忘了登记裁决当场是编译错误，而不是运行期静默落到默认。**读取**面开放：读的是一个来路不明、
// 可能刚跨过 HTTP 的对象，本进程不认识的 kind 只能诚实地回答「拿不到裁决」，由调用方退到安全侧。

import { readMcpCommandErrorKind } from './errors'

/** `McpCommandError.kind` 的全集。新增一个抛出点就在这里加一个成员，并在下表登记裁决。 */
export type McpFailureKind =
  | 'invalid_input'
  | 'command_spawn_failed'
  | 'protocol_error'
  | 'spawn_failed'
  | 'process_exited'
  | 'transport_closed'
  | 'transport_error'
  | 'timeout'
  | 'rpc_error'
  | 'not_connected'
  | 'stale_session'
  | 'already_connected'
  | 'session_limit'
  | 'worker_failed'

/**
 * 归因标签。客户端拿它选文案（`tools/mcp` 的 REASON_LABEL、连接工具的 hint 表）。
 *
 * 这里**只声明本表用得到的四个**，不是客户端那份词表的副本：客户端还有几个只可能由它自己产生的
 * 归因（HTTP 401/403 的 auth、工具数超限、工具重名……），后端这条路上根本到不了。认不出的归因不
 * 影响裁决、只退到通用文案，所以两边词表演进不同步的代价是「文案糙一点」，不是「无限重连」。
 */
export type McpFailureReason =
  | 'config_invalid'
  | 'command_unavailable'
  | 'protocol_violation'
  | 'connection_disrupted'

export interface McpFailureVerdict {
  /** 原样重试还有没有意义。`false` = 永久失败，退避重连一次都不该发。 */
  readonly retryable: boolean
  readonly reason: McpFailureReason
}

/** 可重试的默认裁决。共用一个对象是安全的：`McpFailureVerdict` 全字段 readonly。 */
const DISRUPTED: McpFailureVerdict = { retryable: true, reason: 'connection_disrupted' }

const KIND_VERDICT: Readonly<Record<McpFailureKind, McpFailureVerdict>> = {
  // ── 永久：同一份输入重试永远是同一个结果，要人改配置、改环境或改服务端实现 ──────────
  /** 入参或配置本身不合法（`validation.ts`、`inputs.ts`、`argNarrowing.ts`、`toolOperations.ts`）。 */
  invalid_input: { retryable: false, reason: 'config_invalid' },
  /** OS 拒绝启动配置里的命令：找不到、不可执行、没权限、argv 里有 NUL（`childProcess.ts`）。
   *  与下面的 `spawn_failed` 是两件事——那边子进程已经起来了。 */
  command_spawn_failed: { retryable: false, reason: 'command_unavailable' },
  /** 对端违反 MCP 契约：解析不了的 tools/list、tools/call 或 initialize 结果、重复游标、本客户端
   *  没实现的 protocolVersion、缺 tools 能力（`initialize.ts`、`results.ts`、`validation.ts`、
   *  `toolOperations.ts`）。重连不会让这些变合法。 */
  protocol_error: { retryable: false, reason: 'protocol_violation' },

  // ── 可重试：宿主、传输或对端的一次性状况，退避重连有意义 ────────────────────────────
  /** 子进程**已经起来了**，是宿主这边接管道/读 pid 失败（`childProcess.ts`）。刻意与
   *  `command_spawn_failed` 分开：那是命令不存在，这是宿主一时资源不够。 */
  spawn_failed: DISRUPTED,
  /** 子进程退出了（`session.ts`）。 */
  process_exited: DISRUPTED,
  /** 传输已关闭 / 写不出去（`session.ts`）。 */
  transport_closed: DISRUPTED,
  transport_error: DISRUPTED,
  /** 这次请求没等到回复（`session.ts`、`toolOperations.ts`）。没等到不等于配置坏了。 */
  timeout: DISRUPTED,
  /** 对端回了一条 JSON-RPC error（`session.ts`）。**这一条尤其不能因为 message 好看就判永久**：
   *  message 冒号之后整段是对端写的。 */
  rpc_error: DISRUPTED,
  /** 会话已经不在了 / 令牌过期 / 同 ID 正在连（`manager.ts`）。重连本来就是出路。 */
  not_connected: DISRUPTED,
  stale_session: DISRUPTED,
  already_connected: DISRUPTED,
  /** 会话令牌到达安全上限（`manager.ts`）。别的会话释放之后就能连上。 */
  session_limit: DISRUPTED,
  /** 宿主自己的执行器崩了（`errors.ts` 的 `workerError`），不是对端的问题。 */
  worker_failed: DISRUPTED,
}

/**
 * 查一个 kind 的裁决；本进程不认识的 kind 返回 `undefined`。
 *
 * 用 `Object.hasOwn` 而不是 `in`：`in` 会走原型链，一个恰好叫 `constructor` 的 kind 就能取到一个
 * 根本不是裁决的东西。
 */
export function mcpFailureVerdictForKind(kind: string): McpFailureVerdict | undefined {
  return Object.hasOwn(KIND_VERDICT, kind) ? KIND_VERDICT[kind as McpFailureKind] : undefined
}

/**
 * 从一个来路不明的抛出物上读出裁决：先按字段取 kind（序列化之后仍然成立，理由见
 * `readMcpCommandErrorKind`），再查表。取不到 kind、或 kind 没登记，都返回 `undefined`——
 * 调用方据此退到可重试的安全侧，而不是把一个未知值当成合法裁决。
 */
export function readMcpFailureVerdict(error: unknown): McpFailureVerdict | undefined {
  const kind = readMcpCommandErrorKind(error)
  return kind === undefined ? undefined : mcpFailureVerdictForKind(kind)
}
