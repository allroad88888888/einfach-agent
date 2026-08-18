// workspace/read 域的返回形状
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_read_types.rs。字段名一律 camelCase，对齐 Rust 侧
// `#[serde(rename_all = "camelCase")]`；可选字段带 `#[serde(skip_serializing_if = "Option::is_none")]`，
// 也就是**值为 None 时那个键根本不出现**在 JSON 里——TS 这边对应「不写这个键」而不是
// 「写成 undefined」。两者在 `JSON.stringify` 之后一样，在进程内注入（CLI / sidecar）时却不同：
// 调用方拿到的是对象本身，`'nextOffset' in result` 会给出两种答案。宿主之间必须同款。
//
// 形状的另一份权威是 core 的 `runtime/workspaceRead.ts`（`ReadWorkspaceFileResult` 逐字段有
// 注释）。**这里刻意不 import 它**：host-node 只在 `createNodeHostInvoke.ts` 引 core 的
// `HostInvoke` 类型，输出形状各域自己声明（同 workspace/rg 的 types.ts）。core 侧每个调用点
// 后面都跟着 `normalizeReadResult`，那才是运行时认结果的地方；这里的类型是「我们承诺发出
// 什么」，不是「core 承诺收到什么」。
//
// 【本文件是 read 域四张卡的共享类型】W1 的字节分页与 W2 的行定位共用下面这一个接口——
// 两种读法是同一条命令 `read_workspace_file` 的两种模式，返回同一个形状，只是各自把对方那组
// 字段留空。W3（列举与搜索）、W4（run index 分页）的结果形状也归这里，它们落地时往下加。

/**
 * `read_workspace_file` 的返回值。字节模式与行模式共用。
 *
 * 两组互斥的字段：字节模式恒给 `offset` / `totalBytes`、按需给 `nextOffset`，四个 `*Line*`
 * 字段一个都不给（算出本段起始行要先扫过它前面的全部内容，而字节模式存在的意义正是不必读
 * 整个文件）；行模式两组都给。
 */
export interface ReadWorkspaceFileResult {
  /** 根相对（Auto 会话读到根外时为绝对）的展示路径，正斜杠。 */
  path: string
  content: string
  /** 本段之后文件里还有内容。**不是**「被 maxBytes 截断」——续读到文件尾时它是 false。 */
  truncated: boolean
  /** 本段 `content` 的 UTF-8 字节数。可能小于请求的 maxBytes（尾部不完整序列被留给下一段）。 */
  bytes: number
  /** 本段起始的字节偏移。 */
  offset: number
  /** 读取时刻的文件总字节数（来自 stat，不是本段）。 */
  totalBytes: number
  /** 仍有后续字节时给出，原样作为下一次的 offset 传回。 */
  nextOffset?: number
  /**
   * **整个文件**的 `sha256:<64 位小写 hex>`，只在首段（offset 0）给出，截断时也给。
   * 用途是给 write_file / apply_patch 当乐观锁；超过 8 MB 不再计算（见 limits.ts）。
   */
  contentHash?: string
  /** 行定位模式：本段第一行的行号（1-based）。 */
  startLine?: number
  /** 行定位模式：本段最后一行的行号（1-based，含）。 */
  endLine?: number
  /** 行定位模式：仍有后续行时给出，直接作为下一次的 startLine。 */
  nextLine?: number
  /** 行定位模式：文件总行数。 */
  totalLines?: number
}
