// 四条 `mcp_*` 命令的线上层：怎么打到本机 Node 服务，以及怎么读回结果与失败。
// ---------------------------------------------------------------------------
// 与 `tauriStdioConnector.ts` 里同名的那几个小函数**逐字对应**，只换了传输：
// `invoke(cmd, { input })` → `invokeServerCommand(cmd, { input })`（`POST /api/invoke/:command`）。
// 认证不自己发明：`host/serverInvoke.ts` 已经把 token 的取用与 `Authorization: Bearer` 收口了。
//
// ═══ 结构化失败怎么过 HTTP ═══
//
// 客户端判「这次 MCP 失败重试还有没有意义」时**一个字都不读 message**：message 里嵌着对端撰写的
// 文本（`rpc_error` 那句话冒号之后整段是 MCP server 写的），让它参与判定，一台 server 随便回一句
// "must not be empty" 就能把自己判成永久失败、停掉全部重连。
//
// 判定本身在**服务端**（host-node 的 `mcp/failureKinds.ts`，输入只有它自己铸造的 `kind`）。
// 客户端不复制那张表——复制品靠人记得两边一起改，漏一条的症状是没有症状：新 kind 落到「可重试」，
// 一个永远起不来的服务被无限退避重连。所以这条路上过来两样东西，都在 502 的失败信封里：
//   · `error` 字段 = `McpCommandError.kind`。本文件用它判「这条连接是不是已经没了」
//     （`isFatalConnectionError` / `disconnect`），**不**用它判重试。
//   · `verdict` 字段 = `{ retryable, reason }`，服务端给出的裁决，原样交给 `tools/mcp` 的分类器。
// 服务端映射见 `apps/server/src/invokeRouteError.ts`（502 + 两个字段）。拿不到裁决时退到
// 「可重试」这个安全侧：宁可多退避几次，也不把一次暂时失败判成需要人工介入的永久失败。
//
// ═══ 为什么失败一定要重新包一个平凡 `Error` ═══
// `ServerInvokeError` 自带 `.status`。而分类器的 `readHttpStatus()` 会把错误对象上
// `status` / `code` / `statusCode` 里 100–599 的整数**当成 MCP 传输观察到的 HTTP 状态**，
// 401 / 403 直接判永久失败。把它原样漏进去，等于让「浏览器与本机服务之间的一次 401」冒充
// 「MCP server 拒绝了我们的凭据」。所以这里一律换成裸 `Error` + 非枚举的裁决。

import {
  attachMcpFailureVerdict,
  type McpFailureVerdict,
  type McpRemoteTool,
} from '@einfach-agent/tools-mcp'
import { invokeServerCommand, ServerInvokeError } from '../host/serverInvoke'

export const CONNECT_TIMEOUT_MS = 30_000
export const LIST_TIMEOUT_MS = 30_000
export const CALL_TIMEOUT_MS = 60_000

/**
 * 服务端用来表达「命令自己失败了（不是路由/认证/请求格式问题）」的状态码。
 * 见文件头：`/api/invoke/:command` 上 502 没有第二种含义，所以这一档的 `error` 字段
 * 可以无歧义地当作 `McpCommandError.kind`。
 */
export const MCP_COMMAND_FAILURE_STATUS = 502

/**
 * 服务端没给出裁决时用的安全默认。
 *
 * 什么时候会没有：命令失败档之外的失败（401、404、外壳自己坏了的 500），以及服务端版本比客户端
 * 旧的那一小段时间。两种错法的代价不对称——把暂时失败判成永久，重试全停、要人来解；把永久失败
 * 判成暂时，只多花几次有上限的退避（1→2→4→8→16→30s 共六次），之后同一个失败照样浮上来。
 */
const UNVERDICTED: McpFailureVerdict = { retryable: true, reason: 'connection_disrupted' }

/** 从一次 HTTP 失败里取出结构化 kind；取不到就是 `undefined`。**只用于判连接死活，不判重试。** */
export function mcpFailureKind(value: unknown): string | undefined {
  if (!(value instanceof ServerInvokeError)) return undefined
  if (value.status !== MCP_COMMAND_FAILURE_STATUS) return undefined
  return value.code
}

/** 服务端给出的重试裁决；取不到就退到安全侧（见 `UNVERDICTED`）。 */
export function mcpFailureVerdict(value: unknown): McpFailureVerdict {
  if (!(value instanceof ServerInvokeError)) return UNVERDICTED
  return value.verdict ?? UNVERDICTED
}

export function abortError(): DOMException {
  return new DOMException('MCP 操作已取消', 'AbortError')
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function isAbortErrorLike(value: unknown): boolean {
  return Boolean(
    value
    && typeof value === 'object'
    && 'name' in value
    && (value as { name?: unknown }).name === 'AbortError',
  )
}

/**
 * 把一次调用失败翻译成给 `tools/mcp` 看的 Error：**message 给人看，裁决才是契约**。
 * 见文件头「为什么失败一定要重新包一个平凡 Error」。
 *
 * 裁决**恒挂**（拿不到就挂安全默认），而不是「有就挂、没有就不挂」：挂着这件事本身就是
 * 「这条错误来自桥」的标记，`tools/mcp` 据此完全不去匹配它的 message——那段文本要么是桥写的，
 * 要么是对端写的，都不是那个包自己的确定性字符串。
 */
export function toError(value: unknown): Error {
  if (isAbortErrorLike(value)) return abortError()
  if (value instanceof ServerInvokeError) {
    return attachMcpFailureVerdict(new Error(value.message), mcpFailureVerdict(value))
  }
  if (value instanceof Error) return value
  if (typeof value === 'string' && value.trim()) return new Error(value)
  return new Error('本机服务的 MCP 调用失败')
}

/**
 * 这次失败是否意味着「这条连接已经没了」。与 `tauriStdioConnector.ts` 的同名函数**逐字同表**
 * ——两个宿主的 kind 取值来自同一份 `McpCommandError`（host-node `mcp/errors.ts` 等价移植自
 * 桌面宿主的 `mcp_types.rs`，已随 T1／提交 `e52c31d` 删除），表分叉就等于同一次失败在两个宿主上有两种后果。
 */
export function isFatalConnectionError(value: unknown): boolean {
  const kind = mcpFailureKind(value)
  return kind === 'not_connected'
    || kind === 'stale_session'
    || kind === 'process_exited'
    || kind === 'transport_closed'
    || kind === 'transport_error'
    || kind === 'process_error'
    || kind === 'worker_failed'
}

/**
 * `AbortSignal` 只让调用方立刻收场，**不取消已经发出去的那次 HTTP 请求**——照搬 Tauri 版的
 * 语义，而且在这条路上同样是对的：服务端的 `mcp_connect` 不会因为 socket 断掉就停下来，
 * 真取消 fetch 只会让「宿主那边其实起了一个子进程」这件事变得不可知。所以仍然是
 * 「立刻结束调用方 + 吞掉迟到的结果 + 迟到成功时补一次 best-effort 注销」。
 */
export function abortable<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  onLateSuccess?: (value: T) => void | Promise<void>,
): Promise<T> {
  if (!signal) return operation
  if (signal.aborted) {
    void operation.then(onLateSuccess, () => {})
    return Promise.reject(abortError())
  }

  return new Promise<T>((resolve, reject) => {
    let aborted = false
    const onAbort = () => {
      aborted = true
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        if (aborted) {
          void onLateSuccess?.(value)
          return
        }
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        if (!aborted) reject(error)
      },
    )
  })
}

/**
 * 发一条 mcp 命令。**`input` 那一层不许抹平**——host-node 的 `mcp/inputs.ts` 文件头写明四条
 * 命令的实参都包在 `input` 里（Tauri command 的参数名），抹平会让同一个 connector 在两个
 * 宿主上一个能用一个不能。
 */
export function invokeMcp<T>(
  command: string,
  input: Record<string, unknown>,
): Promise<T> {
  return invokeServerCommand<T>(command, { input })
}

export async function bestEffortDisconnect(
  serverId: string,
  sessionToken: string,
): Promise<void> {
  try {
    await invokeMcp('mcp_disconnect', { serverId, sessionToken, gracePeriodMs: 500 })
  } catch {
    // 迟到的 connect 可能本来就失败了，或者服务已经不在了。
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 与 Tauri 版逐字相同：名称与 inputSchema 是硬判据，其余字段按存在与否透传。 */
export function normalizeTool(value: unknown): McpRemoteTool {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name.trim()) {
    throw new Error('MCP tools/list 返回了名称无效的工具')
  }
  if (!isRecord(value.inputSchema)) {
    throw new Error(
      `MCP 工具 "${value.name.slice(0, 120)}" 的 inputSchema 必须是对象`,
    )
  }
  return {
    ...value,
    name: value.name,
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    inputSchema: value.inputSchema,
    ...(isRecord(value.annotations) ? { annotations: value.annotations } : {}),
  }
}
