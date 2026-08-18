// patch 域跨文件共享的类型
// ---------------------------------------------------------------------------
// 这个域最终只产出一条命令（`apply_workspace_patch`），实现按 Rust 侧的分工摊成若干文件：
// 操作定义、路径解析、限额、乐观守卫、暂存、落盘流水线。它们之间要传的形状放在本文件，
// **不要藏进某个实现文件里再从那里 import**——这个域是两张卡（W12/W13）接力写的。
//
// 还没在这里的三组类型，各自有明确的归宿，别在本文件里另起一份：
//   · 命令**入参**形状 —— 已经在 `src/commandArgs.ts` 的 `apply_workspace_patch` 条目里
//     （顶层键 snake_case：`operations` / `dry_run` / `workspace_root` / `change_context`）。
//   · 命令**返回**形状（Rust 的 `WorkspacePatchResult` / `PatchFileChange` /
//     `RejectedOperation`）—— 随主流水线（W13）一起落。
//   · `ChangeFileInput` / `WorkspaceChangeSummary` —— 属于 `workspace/change` 域，patch 只是
//     它的调用方。

import type { WorkspacePatchOperationArgs } from '../../commandPayloads'

/**
 * 模型可下发的一个补丁操作，对齐 Rust `workspace_patch_operation.rs` 的 `PatchOperation`。
 *
 * **形状不在这里重新声明**，直接复用命令入参里那一份（同 `workspace/change` 复用
 * `WorkspaceChangeContextArgs` 的做法）：两者本来就是同一个东西——Rust 侧就是 serde 直接把
 * 命令入参反序列化成这个枚举，中间没有第二种表示。
 *
 * 大小写是这条命令最容易写错的地方，**判别值与字段名两层不同款**：
 *   · 判别键 `type` 的取值是 **snake_case**：`add_file` / `delete_file` / `replace` /
 *     `overwrite_file`（Rust 的 `#[serde(tag = "type", rename_all = "snake_case")]`）。
 *   · 载荷字段一律 **camelCase**：`oldContent` / `expectedContentHash` / `oldText` /
 *     `newText` / `expectedReplacements`（Rust 逐个字段写了 `#[serde(rename = "...")]`）。
 *   命令顶层的 `rename_all = "snake_case"` 只管顶层键，管不到这里。
 */
export type PatchOperation = WorkspacePatchOperationArgs

/**
 * 暂存表里一个文件的状态，对齐 Rust `workspace_patch_stage.rs` 的 `FileState`。
 *
 * `null` 表示「那一刻文件不存在」（Rust 的 `Option<String>` 为 `None`）——不用 `undefined`：
 * 这三个字段全程参与判等与回滚判定，两种"空"共存迟早会写出 `state.current === undefined`
 * 这种只在一条分支上成立的判断。
 */
export interface PatchFileState {
  /** 本批开始时磁盘上的内容。`null` = 当时不存在。整批期间**不再变**，回滚与「是否新建」都看它。 */
  initial: string | null
  /** 暂存到此刻的内容。`null` = 已被删除（或本来就不存在）。 */
  current: string | null
  /**
   * 最后一个显式给出 `executable` 的操作留下的请求；`null` = 整批没人提过，落盘时不动权限位。
   * 注意 `false` 与 `null` 不同：前者是「显式要求去掉执行位」。
   */
  executable: boolean | null
}

/**
 * 整批补丁的暂存表：**已解析的绝对路径** → 文件状态。
 *
 * 键必须是 `resolvePatchPath` 的返回值而不是入参原文，否则 `a.txt` 与 `./a.txt` 会各占一格，
 * 同一个文件被当成两个、后写的那次静默盖掉前一次。
 */
export type StagedFiles = Map<string, PatchFileState>

/**
 * 读「本批开始时磁盘上的文本」的口子，由调用方注入。
 *
 * 对应 Rust `workspace_patch_fs.rs` 的 `read_optional_text_file`（不存在 → `Ok(None)`，
 * 目录/超限/二进制 → `Err`）。**实现属于 W13**：暂存这一层只认「给我内容或告诉我没有」，
 * 把唯一的 IO 收成一个可替换的参数，纯规则那部分才能在没有临时目录树的情况下被 fixture 直接喂。
 */
export type ReadInitialText = (absolutePath: string) => Promise<string | null>
