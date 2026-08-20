// MCP 命令的结构化失败：一个既是 Error、又能原样序列化成 Rust 那份形状的东西
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/mcp_types.rs（已随 T1 删除）的 `McpCommandError`。
//
// **为什么必须带 `kind` 而不能只留一句话**：「这次失败重试还有没有意义」只认 kind，一个字都不读
// message——message 里嵌着对端撰写的文本，让它参与判定，一台 MCP server 随便回一句
// "must not be empty" 就能把自己判成永久失败、停掉全部重试。所以 kind 是契约，message 不是。
// 改 message 安全，改 kind 会改变重试行为——但不会**静默**改变：kind 是闭合 union，裁决表
// （`failureKinds.ts` 的 `KIND_VERDICT`）按它穷举，新增一个 kind 忘了登记当场编译错误。
// 判定本身也留在那张表里，不再有第二份：客户端只读裁决、不自己判（见 `failureKinds.ts` 文件头）。
//
// **为什么既 extends Error 又有 toJSON**：Rust 侧 `Result<T, McpCommandError>` 的 Err 经 Tauri
// 序列化成一个**普通对象**（不是 Error），前端 `tauriStdioConnector.ts` 直接读 `value.kind`。
// Node 这张路由表要同时挂在三种传输后面：
//   · 进程内（CLI / sidecar）—— 调用方 catch 到的就是这个对象，`instanceof Error` 成立，
//     堆栈可用，`.kind` 直接可读；
//   · HTTP（S 线的 `POST /api/invoke/:command`）—— 中间隔一次 `JSON.stringify`，而 Error 的
//     `message` / `name` 都是**不可枚举**的，裸 Error 序列化出来是 `{}`。`toJSON()` 因此不是
//     锦上添花，是让 kind 能活着穿过 HTTP 的唯一办法。
// 两条路上拿到的字段名与 Rust 逐字相同（camelCase，`serverId` / `rpcCode`），C4 的
// serverStdioConnector 才能原样复用 tauriStdioConnector 的解析。

import type { McpFailureKind } from './failureKinds'

/** 序列化后的形状，与 Rust `McpCommandError` 的 serde 输出逐字段对齐。 */
export interface McpCommandErrorJson {
  kind: McpFailureKind
  message: string
  serverId?: string
  rpcCode?: number
  data?: unknown
}

export class McpCommandError extends Error {
  override readonly name = 'McpCommandError'
  readonly kind: McpFailureKind
  /** 归属的服务 ID。入参归一化失败时还不知道是哪个服务，此时缺席——Rust 同样。 */
  readonly serverId: string | undefined
  /** 仅 `rpc_error`：对端 JSON-RPC error 的 code。 */
  readonly rpcCode: number | undefined
  /** 仅 `rpc_error`：对端 JSON-RPC error 的 data，原样透传、不解释。 */
  readonly data: unknown

  constructor(
    kind: McpFailureKind,
    message: string,
    extra: { serverId?: string; rpcCode?: number; data?: unknown } = {},
  ) {
    super(message)
    this.kind = kind
    this.serverId = extra.serverId
    this.rpcCode = extra.rpcCode
    this.data = extra.data
  }

  /**
   * 补上服务 ID。等价 Rust 的 `for_server`：那边是消耗 self 再返回，这里返回**新实例**
   * 而不是就地改字段——字段是 readonly，且同一个错误对象不该在传递途中变形。
   */
  forServer(serverId: string): McpCommandError {
    return new McpCommandError(this.kind, this.message, {
      serverId,
      rpcCode: this.rpcCode,
      data: this.data,
    })
  }

  toJSON(): McpCommandErrorJson {
    return {
      kind: this.kind,
      message: this.message,
      // Rust 那边是 `skip_serializing_if = "Option::is_none"`：缺席就是**键不存在**，
      // 不是 `null`。这里用条件展开而不是写 `serverId: this.serverId`，否则
      // JSON.stringify 会把 undefined 的键整个丢掉——碰巧结果一样，但 `structuredClone`
      // （sidecar 传输）会保留 `serverId: undefined`，两种传输的键集合就不一致了。
      ...(this.serverId === undefined ? {} : { serverId: this.serverId }),
      ...(this.rpcCode === undefined ? {} : { rpcCode: this.rpcCode }),
      ...(this.data === undefined ? {} : { data: this.data }),
    }
  }
}

/**
 * 跑一段可能抛 `McpCommandError` 的代码，给抛出来的错误补上服务 ID。
 *
 * 等价 Rust 里满地的 `.map_err(|error| error.for_server(&server_id))`：`normalizeIdentifier`
 * 这类通用校验不知道自己在为哪个服务工作，而调用方知道。缺了这一步，UI 上会出现一条不知道
 * 该归给谁的失败——服务卡片仍显示「已连接」，错误却飘在外面。
 */
export function withServerId<T>(serverId: string, run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof McpCommandError) throw error.forServer(serverId)
    throw error
  }
}

/** 等价 Rust 的 `McpCommandError::worker`：宿主自己的执行器崩了，不是对端的问题。 */
export function workerError(message: string): McpCommandError {
  return new McpCommandError('worker_failed', message)
}

/**
 * 从一个来路不明的抛出物上读 `kind`。
 *
 * **只看字段，不看类型身份**——理由与 model 域的 `readModelRequestErrorReason` 逐字相同：
 * 这条路上错误要跨 HTTP 序列化（`POST /api/invoke/:command` 那一头拿到的是 `toJSON()` 的产物，
 * 一袋 JSON，原型没了）。宿主外壳（`apps/server` 的 invokeRouteError.ts）用它把 kind 放进失败
 * 信封的 `error` 字段，客户端拿它判「这条连接是不是已经没了」（`isFatalConnectionError`）。
 *
 * **读取面刻意保持开放 string**，与同文件里闭合的**铸造**面（构造函数的 `McpFailureKind`）分工不同：
 * 这里读的是一个来路不明的对象，可能来自版本不一致的另一侧。在读取面立一张白名单，等于让本进程
 * 不认识的 kind 变成 `undefined` 之后**再也分不清**「它没带 kind」和「它带了一个我不认识的 kind」；
 * 而真正需要防的「新增 kind 忘了登记裁决」由 `failureKinds.ts` 的穷举表在编译期挡住，不靠这里。
 */
export function readMcpCommandErrorKind(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const kind = (error as { kind?: unknown }).kind
  return typeof kind === 'string' && kind.length > 0 ? kind : undefined
}
