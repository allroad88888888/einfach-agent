// MCP 命令的结构化失败：一个既是 Error、又能原样序列化成 Rust 那份形状的东西
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/mcp_types.rs 的 `McpCommandError`。
//
// **为什么必须带 `kind` 而不能只留一句话**：`tools/mcp` 的失败分类器
// （failureClassification.ts）判「这次失败重试还有没有意义」时，对 stdio 桥**只认 kind**，
// 一个字都不读 message——理由写在那个文件里：message 里嵌着对端撰写的文本，让它参与判定，
// 一台 MCP server 随便回一句 "must not be empty" 就能把自己判成永久失败、停掉全部重试。
// 所以 kind 是契约，message 不是。改 message 安全，改 kind 会静默改变重试行为。
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

/** 序列化后的形状，与 Rust `McpCommandError` 的 serde 输出逐字段对齐。 */
export interface McpCommandErrorJson {
  kind: string
  message: string
  serverId?: string
  rpcCode?: number
  data?: unknown
}

export class McpCommandError extends Error {
  override readonly name = 'McpCommandError'
  readonly kind: string
  /** 归属的服务 ID。入参归一化失败时还不知道是哪个服务，此时缺席——Rust 同样。 */
  readonly serverId: string | undefined
  /** 仅 `rpc_error`：对端 JSON-RPC error 的 code。 */
  readonly rpcCode: number | undefined
  /** 仅 `rpc_error`：对端 JSON-RPC error 的 data，原样透传、不解释。 */
  readonly data: unknown

  constructor(
    kind: string,
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
 * 信封的 `error` 字段，客户端再交给 `tools/mcp` 的失败分类器。
 *
 * **取值刻意不收成闭合枚举**，与 model 域那边正相反：`kind` 在 Rust 侧就是一个开放 String
 * （`apps/desktop/src/mcp_types.rs` 的 `pub kind: String`），消费方的契约也写明「只有列出的
 * kind 是永久失败，其余一律落到可重试的默认」（`tools/mcp/src/failureClassification.ts`）。
 * 在这里立一张白名单，等于让**没登记的新 kind 静默变成 undefined**——那正好把「新增一类永久
 * 失败」变成「安静地无限重连」，而白名单漏一条不会有任何编译错误。
 */
export function readMcpCommandErrorKind(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const kind = (error as { kind?: unknown }).kind
  return typeof kind === 'string' && kind.length > 0 ? kind : undefined
}
