// write 域跨文件共享的类型
// ---------------------------------------------------------------------------
// 这个域最终只产出一条命令（`write_workspace_file`），但实现按 Rust 侧的分工摊成七八个文件：
// 目标路径、限额、写锁、乐观守卫、base64、归档 compaction、主流水线。它们之间要传的形状放在
// 本文件，**不要藏进某个实现文件里再从那里 import**——那样第二个用它的人只能顺着 import 链找，
// 而这个域是多张卡并行写的。
//
// 还没在这里的两组类型，各自有明确的归宿，别在本文件里另起一份：
//   · 命令**入参**形状 —— 已经在 `src/commandArgs.ts` 的 `write_workspace_file` 条目里
//     （顶层键 snake_case、`change_context` 的值内部 camelCase）。
//   · 命令**返回**形状（Rust 的 `WorkspaceWriteResult`）与变更日志的 `ChangeFileInput` /
//     `WorkspaceChangeSummary` —— 前者随主流水线一起落，后者属于 `workspace/change` 域。

/**
 * 写入模式，对齐 Rust `workspace_write_options.rs` 的 `WriteMode`。
 *
 * `upsert` 不是第四种写法：它在流水线里按「目标是否已存在」被折算成 `create` 或 `overwrite`，
 * 存在的意义是省掉调用方先读一次探路的往返。
 *
 * 这里只声明取值集合；把字符串入参解析成它（含 `invalid mode ...` 文案）是 options 那一层的事。
 */
export type WriteMode = 'create' | 'overwrite' | 'append' | 'upsert'

/**
 * `content` 在传输上的载法，对齐 Rust 的 `ContentEncoding`。
 * base64 的存在理由是 JSON 字符串装不下任意字节——没有它就根本写不出二进制文件。
 */
export type ContentEncoding = 'utf8' | 'base64'

/** 解析完成的写入目标：一个给文件系统用，一个给人和模型看。 */
export interface ResolvedWriteTarget {
  /**
   * 落盘用的绝对路径。已存在的那一段是 canonicalize 过的（符号链接已解开），尚不存在的几段
   * 按字面接在后面——它们还没有真实路径可言。
   */
  absolutePath: string
  /**
   * 对外展示与写进变更日志的路径：相对 workspace root、一律正斜杠。
   * **返回给模型和聊天记录的 `path` 字段必须用它**，绝对路径会泄漏本机目录结构。
   */
  displayPath: string
}
