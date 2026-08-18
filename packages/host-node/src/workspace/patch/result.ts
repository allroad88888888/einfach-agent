// `apply_workspace_patch` 回给调用方的结果形状
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_patch_result.rs。只有类型声明，构造在 pipeline.ts。
//
// 【三个键的"空"各有各的写法，别统一】判据始终是「Rust 序列化出来有没有这个键」：
//   · `changeSet` —— `Option<WorkspaceChangeSummary>` **没有** skip_serializing_if，没记账时
//     Rust 写出的是 `"changeSet": null`。所以这里是 `T | null` 而不是可选属性。
//   · `changeSummary` —— **有** skip_serializing_if，删除操作没有 after 可 diff 时那个键整个不出现。
//   · `path`（rejected 里的）—— 同样没有 skip_serializing_if；虽然流水线永远填得出来，形状仍按
//     Rust 写成可空。
// core 的 `normalizeResult` 两种都吃得下，但两个宿主对同一次调用应当给出同一份 JSON——套壳之后
// 这是唯一能机械对拍的东西。

import type { FileChangeSummary } from './changeSummary'
import type { WorkspaceChangeSummary } from '../change/types'

/** 被拒的一条操作。`index` 是它在 `operations[]` 里的下标，模型据此知道是第几条不成立。 */
export interface RejectedOperation {
  index: number
  /** 操作名，就是入参里的 `type`（`add_file` / `delete_file` / `replace` / `overwrite_file`）。 */
  operation: string
  path: string | null
  reason: string
}

/** 一个文件被改成什么样。与 write_file 的回执同形，两个工具报同一件事用同一种说法。 */
export interface PatchFileChange {
  /** 根相对、正斜杠的展示路径。 */
  path: string
  created: boolean
  deleted: boolean
  /** 删除没有 after 可 diff，此时整个键不出现。 */
  changeSummary?: FileChangeSummary
}

export interface WorkspacePatchResult {
  /**
   * **`ok` 为假只有一种情况：有操作被拒。** 落盘中途失败不走这里——那是整条命令失败
   * （抛错），因为那时工作区处于什么状态取决于还原成没成功，不是一个「结果」能表达的。
   */
  ok: boolean
  changedFiles: string[]
  changes: PatchFileChange[]
  rejected: RejectedOperation[]
  dryRun: boolean
  wouldChange: boolean
  summary: string
  changeSet: WorkspaceChangeSummary | null
}
