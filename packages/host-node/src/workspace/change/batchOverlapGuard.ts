// 一批账能不能安全地放在一起回滚（纯判定，不碰盘）
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_change_journal_batch.rs:49-91（已随 T1 删除）。做成纯函数是刻意的：它是
// 整个批量回滚里唯一「不看磁盘就能下结论」的一关，W16 的跨语言对拍能直接喂 fixture。
//
// ═══ 它到底在防什么 ═══
// 批量回滚对**同一个文件的连续多次改动**是成立的：逆着创建顺序一条条退，每条的 `after` 恰好是
// 下一条退完后的现状。这是它的正常用法，所以「同一路径出现在多条账的 `files` 里」不算冲突。
//
// 但另外三种重叠没有这种「一条接一条退回去」的结构，硬要一起退就会互相踩：
//   1. **同一路径既被整文件改写、又被删除/复制/移动。** 前者按内容还原，后者按整棵路径搬运，
//      两种还原方式对同一个路径同时生效时，谁后跑谁说了算——而「谁后跑」取决于账的顺序，
//      结果因此不可预测。
//   2. **同一路径在多条账里被删除。** 每条账的载荷都声称自己是那条路径的原样，退完一条再退
//      下一条，后者会把前者刚放回去的东西盖掉。
//   3. **同一路径在多条账里被复制/移动。** 同上，指纹预检还会因为「已经被上一条改回去了」
//      而通过，掩盖问题。
//
// 撞上就整批拒绝，**一条都不退**。这条边界画得偏保守（有些组合其实退得动），但它换来的是
// 「批量回滚要么全成要么全不动」这条能一句话说清的承诺，值这个价。
//
// 已经回滚过的账**不参与**判定（调用方传进来的就该是待回滚的那些）——它们不会再被执行，
// 把它们的路径算进来只会误报。

import type { WorkspaceChangeSet } from './types'

const OVERLAP_MESSAGE =
  'batch rollback cannot safely combine overlapping path-delete and file changes'

/**
 * 能安全合批 → `null`；不能 → 那句原文（Rust 侧只有这一句，不区分是哪种重叠）。
 *
 * @param pending 待回滚的账，**状态已是 `reverted` 的不要传进来**。顺序无关。
 */
export function batchOverlapMessage(pending: readonly WorkspaceChangeSet[]): string | null {
  const movedPaths = pending.flatMap((entry) => entry.movedPaths.map((item) => item.path))
  const structuredPaths = pending.flatMap((entry) => [
    ...entry.createdPaths.map((item) => item.path),
    ...entry.relocatedPaths.flatMap((item) => [item.source, item.destination]),
  ])
  const uniqueMoved = new Set(movedPaths)
  const uniqueStructured = new Set(structuredPaths)

  const fileCollides = pending
    .flatMap((entry) => entry.files)
    .some((file) => uniqueMoved.has(file.path) || uniqueStructured.has(file.path))

  // 去重前后数量不等 = 同一条路径在多条账（或同一条账）里被搬运了不止一次。
  const duplicateMoved = uniqueMoved.size !== movedPaths.length
  const duplicateStructured = uniqueStructured.size !== structuredPaths.length

  return fileCollides || duplicateMoved || duplicateStructured ? OVERLAP_MESSAGE : null
}
