// 四条 `mcp_*` 命令的线上层：怎么打到本机 Node 服务，以及怎么读回结果与失败。
// ---------------------------------------------------------------------------
// 与 `tauriStdioConnector.ts` 里同名的那几个小函数**逐字对应**，只换了传输：
// `invoke(cmd, { input })` → `invokeServerCommand(cmd, { input })`（`POST /api/invoke/:command`）。
// 认证不自己发明：`host/serverInvoke.ts` 已经把 token 的取用与 `Authorization: Bearer` 收口了。
//
// ═══ 【交回时点名的缺口】`kind` 目前穿不过 HTTP ═══
//
// `tools/mcp` 的失败分类器对 stdio 桥**只认 `kind`、一个字都不读 message**
// （`failureClassification.ts` 文件头写明理由：message 里嵌着对端撰写的文本，让它参与判定，
// 一台 MCP server 随便回一句 "must not be empty" 就能把自己判成永久失败）。
// host-node 的 `McpCommandError` 为此专门实现了 `toJSON()`，其文件头写着
// 「C4 的 serverStdioConnector 才能原样复用 tauriStdioConnector 的解析」。
//
// **但那条路今天是断的**，已核到行：`apps/server/src/invokeRoute.ts` 的 catch 只认
// `NodeHostCommandError`（→ 404 / 501），`McpCommandError` 不是它的实例，于是被 `throw error`
// 重抛，落进 `requestRouter.ts` 的外层 catch，变成一条 **`text/plain` 的 500「服务端内部错误。」**
// ——`kind` 没了，连 message 也没了。所以在服务端补上这一跳之前，本文件拿不到任何 kind，
// 全部 MCP 失败都会被分类器判成「可重试」（`command_spawn_failed` 这种「命令根本不存在」
// 也会被无限重连）。
//
// 本文件按**修好之后**的形状写：服务端把 `McpCommandError` 映射成
// `{ statusCode: 502, error: <kind>, message: <message> }`，失败信封的 `error` 字段本来就是
// 「给程序看的稳定标识」，与 `kind` 是同一个东西，不需要给信封加新字段，也不需要动
// `ServerInvokeError`（`.status` + `.code` 已经够）。502 在 `/api/invoke/:command` 上没有别的
// 用法（`modelRoute` 的 502 是另一条路由），所以「502 的 code 就是 kind」不会与任何东西撞。
// 服务端没补上时，这里只是恒拿不到 kind，行为是安全降级而不是出错。
//
// ═══ 为什么失败一定要重新包一个平凡 `Error` ═══
// `ServerInvokeError` 自带 `.status`。而分类器的 `readHttpStatus()` 会把错误对象上
// `status` / `code` / `statusCode` 里 100–599 的整数**当成 MCP 传输观察到的 HTTP 状态**，
// 401 / 403 直接判永久失败。把它原样漏进去，等于让「浏览器与本机服务之间的一次 401」冒充
// 「MCP server 拒绝了我们的凭据」。所以这里一律换成裸 `Error` + 非枚举的 kind。

import {
  attachMcpFailureKind,
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

/** 从一次 HTTP 失败里取出结构化 kind；取不到就是 `undefined`（分类器会退到「可重试」）。 */
export function mcpFailureKind(value: unknown): string | undefined {
  if (!(value instanceof ServerInvokeError)) return undefined
  if (value.status !== MCP_COMMAND_FAILURE_STATUS) return undefined
  return value.code
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
 * 把一次调用失败翻译成给 `tools/mcp` 看的 Error：**message 给人看，kind 才是契约**。
 * 见文件头「为什么失败一定要重新包一个平凡 Error」。
 */
export function toError(value: unknown): Error {
  if (isAbortErrorLike(value)) return abortError()
  if (value instanceof ServerInvokeError) {
    return attachMcpFailureKind(new Error(value.message), mcpFailureKind(value))
  }
  if (value instanceof Error) return value
  if (typeof value === 'string' && value.trim()) return new Error(value)
  return new Error('本机服务的 MCP 调用失败')
}

/**
 * 这次失败是否意味着「这条连接已经没了」。与 `tauriStdioConnector.ts` 的同名函数**逐字同表**
 * ——两个宿主的 kind 取值来自同一份 `McpCommandError`（host-node `mcp/errors.ts` 等价移植自
 * `apps/desktop/src/mcp_types.rs`），表分叉就等于同一次失败在两个宿主上有两种后果。
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
