// 回滚结果的三种形状，以及「会被还原的路径清单」怎么取
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_change_journal_types.rs（已随 T1 删除）的 `error_result`，外加 Rust 侧
// 在 revert.rs / batch.rs 里逐处内联写出的另外两种结果字面量。三种形状的差别是**语义级的**，
// 收在一处才看得出来：
//
//   · `successResult` —— `ok: true`。预演（`ready` / `batch_ready`）、真回滚（`reverted` /
//     `batch_reverted`）与「早就回滚过了」（`already_reverted`）都走它。
//   · `conflictResult` —— `ok: false`，**conflicts 非空、error 为 null**。预检发现现场变了，
//     调用方要把每条冲突逐条显示给用户。
//   · `errorResult` —— `ok: false`，**error 非空、conflicts 为空**。这次回滚没法进行，或者
//     进行到一半失败了。
//
// ⚠️ **status `'conflict'` 会从两条路上产生，形状还不一样**：预检冲突走 `conflictResult`
// （有 conflicts、无 error），执行中途才发现的漂移走 `errorResult('conflict', ...)`（有 error、
// 无 conflicts）。看着像重复，其实是 Rust 侧的既有契约——前者能逐条指出哪些文件变了，后者只
//知道停在哪一条。照搬，不合并。
//
// 每个字段都显式写出（包括 `error: null` 与空数组），理由与 types.ts 第 2 条约定同源：
// `JSON.stringify` 会把值为 `undefined` 的键整个丢掉，而 Rust 的 `Option<String>` 序列化成
// 显式 `null`。少写一个键，两个宿主的回滚回执形状就不一样了，且不报错。

import type { WorkspaceChangeConflict, WorkspaceChangeSet, WorkspaceRevertResult } from './types'

/** 成功的回滚/预演。`revertedChangeSetIds` 只在**真的改过盘**的那两种 status 上非空。 */
export function successResult(
  status: WorkspaceRevertResult['status'],
  restoredFiles: string[],
  revertedChangeSetIds: string[] = [],
): WorkspaceRevertResult {
  return { ok: true, status, restoredFiles, conflicts: [], error: null, revertedChangeSetIds }
}

/** 预检冲突：一条盘都没碰，逐条报告哪些路径与账对不上。 */
export function conflictResult(conflicts: WorkspaceChangeConflict[]): WorkspaceRevertResult {
  return {
    ok: false,
    status: 'conflict',
    restoredFiles: [],
    conflicts,
    error: null,
    revertedChangeSetIds: [],
  }
}

/** 等价 Rust 的 `error_result`：一句话说明为什么这次回滚不成立。 */
export function errorResult(
  status: WorkspaceRevertResult['status'],
  error: string,
): WorkspaceRevertResult {
  return {
    ok: false,
    status,
    restoredFiles: [],
    conflicts: [],
    error,
    revertedChangeSetIds: [],
  }
}

/**
 * 一条账被回滚后会「回到原样」的路径清单，也就是回执里的 `restoredFiles`。
 *
 * 四段的**拼接顺序是对外契约**（Rust revert.rs:206-210 与 batch.rs:166-174 逐字相同）：
 * 整文件改写 → 被删路径 → 被新建路径 → 被移动路径的 **source**。最后一段取 source 而不是
 * destination，是因为回滚把东西搬回 source，那才是「还原后它在哪」。
 *
 * 预演与真跑用的是同一个函数——这正是 `dryRun` 的承诺：报告的清单与真跑逐字相同。
 */
export function restoredFilePaths(entry: WorkspaceChangeSet): string[] {
  return [
    ...entry.files.map((file) => file.path),
    ...entry.movedPaths.map((item) => item.path),
    ...entry.createdPaths.map((item) => item.path),
    ...entry.relocatedPaths.map((item) => item.source),
  ]
}
