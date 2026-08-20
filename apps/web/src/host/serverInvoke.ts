// HTTP 版 `HostInvoke` —— 把 core 的 `<T>(cmd, args?) => Promise<T>` 契约打到
// `/api/invoke/:command`（server 侧路由，S3 落的 `apps/server/src/invokeRoute.ts`）。
// ---------------------------------------------------------------------------
// 【本文件唯一"抄"服务端的常量】`INVOKE_ROUTE_PREFIX`——见下方它自己的注释。除此之外这一层
// 不复制服务端的任何校验/命令表逻辑：命令是否存在只有 host-node 一处权威（S3 的既定协议），
// 这里只管"HTTP 请求怎么发、失败怎么翻译"。不 import `apps/server` 的任何源码（app 对 app
// 不成立的依赖方向），需要的常量都在本文件本地声明。
//
// 【reject 的形状：裸字符串，不是 Error，更不是 `{error, message}` 对象】
// Tauri 的 invoke 失败时 reject 的是 Rust 侧 `Err(String)` 里那个裸字符串——实测过
// 这条形状移植自桌面宿主的 `shell.rs`（已随 T1／提交 `e52c31d` 删除，只能从 Git 历史读）：
// 它的 `run_shell_command` 签名是 `Result<ShellCommandResult, String>`，
// `window.__TAURI_INTERNALS__.invoke` 原样把这个 String 抛给调用方，不包一层 Error、更不是一个
// 结构化对象。core 里消费失败的地方（`packages/agent-core/src/runtime/` 下十余处 `catch (error)`，
// 比如 `shellCommand.ts:122`、`workspaceRead.ts` 的四处、`workspaceWrite/Patch/Delete/Git/Task/
// PathOperation` 各一处）统一按两种写法之一处理：要么是本文件同款的 `messageFromError`
// （`error instanceof Error` 取 `.message`，`typeof error === 'string'` 原样返回，其余
// `JSON.stringify` 兜底），要么是更简的 `error instanceof Error ? error.message : String(error)`。
// 后一种写法只要 reject 的不是 `Error` 实例就会退到 `String(error)`——**如果 reject 的是
// `{error, message}` 这个原始失败信封对象，`String(error)` 得到的是 `"[object Object]"`**，
// 把一句本该给用户/模型看的准确中文吞成一句没有信息量的英文占位符。裸字符串在两种写法下都能拿到
// 原文，是唯一在全部调用点都不出岔子的形状，所以这里选它——不选 Error 实例（虽然 Error 实例同样
// 会被两种写法正确处理，但字符串是与 Tauri 逐字一致的那个选择，没有理由多包一层）。
//
// 【401 怎么被"上层"识别】
// 上面这条决定了 `httpInvoke`（挂进 `configureHostInvoke` 的那个函数）对外只吐裸字符串——这与
// "401 能被上层识别"是两件不冲突的事：本文件把"发请求、拿结构化失败"和"折叠成裸字符串"拆成了
// 两层——`invokeServerCommand` 只抛 `ServerInvokeError`（带 `status`/`code`，从不折叠），
// `httpInvoke` 只是它的一层瘦包装，负责把 `ServerInvokeError` 折成 `.message`。谁需要在不解析
// 中文文案的前提下判断"这是一次 401"，绕开 `httpInvoke` 直接调 `invokeServerCommand`
// （或用 `isServerInvokeUnauthorized()`）就行；`httpInvoke` 自己这条路径上没有这个能力，
// 也不该有——它的契约就是"跟 Tauri 一样吐一个字符串"。
import type { HostInvoke } from '@einfach-agent/core'
import { getServerInvokeToken, type ServerInvokeTokenEnvironment } from './serverInvokeToken'

/**
 * 与 `apps/server/src/invokeRouteCommandName.ts` 的 `INVOKE_ROUTE_PREFIX` 对应。
 * 相对路径（不带 origin）——这层从不跨源：页面本身就是这台 server 发出来的静态产物，
 * 调用的也是同一台 server，相对路径天然同源，不需要也不应该拼出 host/port。
 */
const INVOKE_ROUTE_PREFIX = '/api/invoke/'

/** 服务端失败信封的形状（`apps/server/src/invokeRoute.ts` 的 `replyApiError`）。 */
interface ServerInvokeErrorEnvelope {
  readonly error: string
  readonly message: string
  readonly verdict?: unknown
}

function isErrorEnvelope(value: unknown): value is ServerInvokeErrorEnvelope {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as Record<string, unknown>).error === 'string'
    && typeof (value as Record<string, unknown>).message === 'string'
  )
}

/**
 * 域给出的重试裁决：「这次失败原样重试还有没有意义」，以及归因。
 *
 * 判定**只在服务端做**（今天只有 mcp 域给，判据是 host-node `mcp/failureKinds.ts` 的 kind 表），
 * 这一层只负责把它从信封里取出来、并确认形状对得上。客户端不复制那张表：复制品靠人记得两边一起
 * 改，漏一条的症状是没有症状——新失败类型静默落到「可重试」，一个永远起不来的服务被无限重连。
 */
export interface ServerCommandVerdict {
  readonly retryable: boolean
  readonly reason: string
}

/** 形状不对就当没有：宁可退到调用方的安全默认，也不把一袋来路不明的字段当成裁决。 */
function readVerdict(value: unknown): ServerCommandVerdict | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { retryable, reason } = value as { retryable?: unknown, reason?: unknown }
  if (typeof retryable !== 'boolean') return undefined
  if (typeof reason !== 'string' || reason.length === 0) return undefined
  return { retryable, reason }
}

/** 未经字符串折叠的失败形态。 */
export interface ServerInvokeFailure {
  /** HTTP 状态码；网络层失败（连不上、被中止）时没有响应，为 `undefined`。 */
  readonly status: number | undefined
  /** 服务端失败信封里的 `error` 字段（给程序看的稳定标识）；解析不出时为 `undefined`。 */
  readonly code: string | undefined
  /** 人能看懂的一句话；任何分支都保证有值。 */
  readonly message: string
  /** 域给出的重试裁决；域没给、或形状不对时缺席。网络层失败同样缺席（压根没有信封）。 */
  readonly verdict?: ServerCommandVerdict
}

/** 供想要结构化判断（比如"这是不是一次 401"）的调用方使用；`httpInvoke` 内部会把它折叠成字符串。 */
export class ServerInvokeError extends Error {
  readonly status: number | undefined
  readonly code: string | undefined
  readonly verdict: ServerCommandVerdict | undefined

  constructor(failure: ServerInvokeFailure) {
    super(failure.message)
    this.name = 'ServerInvokeError'
    this.status = failure.status
    this.code = failure.code
    this.verdict = failure.verdict
  }
}

/** 401 判定：只看状态码，不解析中文文案。只对 `invokeServerCommand` 抛出的原始异常有意义——
 * `httpInvoke` 折叠后的裸字符串走不到这里（那正是它作为 `HostInvoke` 该有的样子）。 */
export function isServerInvokeUnauthorized(error: unknown): error is ServerInvokeError {
  return error instanceof ServerInvokeError && error.status === 401
}

function messageFromError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** 本文件用得到的 fetch 形状；写窄便于测试注入假实现（同 `resolveHost.ts` 的写法）。 */
export type ServerInvokeFetch = (
  input: string,
  init: {
    readonly method: string
    readonly headers: Record<string, string>
    readonly body: string
  },
) => Promise<{
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}>

const defaultServerInvokeFetch: ServerInvokeFetch = (input, init) => globalThis.fetch(input, init)

export interface ServerInvokeOptions {
  readonly fetch?: ServerInvokeFetch
  readonly tokenEnvironment?: ServerInvokeTokenEnvironment
}

function buildHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  // 没有 token 时不带这个头，而不是带一个空字符串——空 Bearer 值在 `authToken.ts` 的
  // `readBearerToken` 里会被 `.trim() === ''` 判成"没带"，效果一样，但省得服务端多想一步。
  if (token) headers.authorization = `Bearer ${token}`
  return headers
}

async function readFailure(
  response: { readonly status: number, json(): Promise<unknown> },
): Promise<ServerInvokeFailure> {
  try {
    const body: unknown = await response.json()
    if (isErrorEnvelope(body)) {
      return {
        status: response.status,
        code: body.error,
        message: body.message,
        verdict: readVerdict(body.verdict),
      }
    }
  } catch {
    // body 不是合法 JSON——不是这条路由本该有的形状，落到下面的通用兜底。
  }
  return {
    status: response.status,
    code: undefined,
    message: `本地服务返回了非预期的错误响应（HTTP ${response.status}）。`,
  }
}

/**
 * 发一次命令调用。失败时**总是**抛 `ServerInvokeError`（网络层失败、非法响应体也不例外），
 * 给需要结构化信息的调用方一个统一的类型可以 `instanceof`。
 */
export async function invokeServerCommand<T>(
  cmd: string,
  args: Record<string, unknown> | undefined,
  options: ServerInvokeOptions = {},
): Promise<T> {
  const fetchImpl = options.fetch ?? defaultServerInvokeFetch
  const token = getServerInvokeToken(options.tokenEnvironment)
  const url = `${INVOKE_ROUTE_PREFIX}${encodeURIComponent(cmd)}`

  let response: Awaited<ReturnType<ServerInvokeFetch>>
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: buildHeaders(token),
      body: JSON.stringify(args ?? {}),
    })
  } catch (error) {
    throw new ServerInvokeError({
      status: undefined,
      code: undefined,
      message: `无法连接本地服务：${messageFromError(error)}`,
    })
  }

  if (!response.ok) {
    throw new ServerInvokeError(await readFailure(response))
  }

  try {
    // `undefined` 不是合法 JSON；S3 那头 `result ?? null` 已经把它变成了 `null`，这里原样
    // 透传给调用方，不做任何形状加工——与 S3 文件头「不做任何大小写转换」是同一条纪律的延续。
    return (await response.json()) as T
  } catch (error) {
    throw new ServerInvokeError({
      status: response.status,
      code: undefined,
      message: `本地服务返回了非预期的响应体：${messageFromError(error)}`,
    })
  }
}

/**
 * 造一个符合 `HostInvoke` 契约的调用函数。生产用途直接用下面导出的 `httpInvoke` 常量即可；
 * 这个工厂只为测试注入假 `fetch`/token 环境而存在。
 */
export function createHttpInvoke(options: ServerInvokeOptions = {}): HostInvoke {
  return async function invokeOverHttp<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    try {
      return await invokeServerCommand<T>(cmd, args, options)
    } catch (error) {
      // 见文件头「reject 的形状」：折叠成裸字符串，匹配 Tauri invoke 的 reject 形状。
      throw error instanceof ServerInvokeError ? error.message : messageFromError(error)
    }
  }
}

/** B3 接线用这个：`configureHostInvoke({ loader: async () => httpInvoke, platform })`。 */
export const httpInvoke: HostInvoke = createHttpInvoke()
