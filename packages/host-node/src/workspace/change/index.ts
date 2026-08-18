// workspace/change 域的 registrar：`revert_workspace_change`
// ---------------------------------------------------------------------------
// 每个域一个 registrar，形状固定：`create<Domain>Routes(options) => NodeHostRouteTable`
// （样板见 src/config/index.ts）。本域只有一条命令——**登记账的那一侧不是命令**，它是
// write / patch / delete / pathOps 四个域在动手前调用的库函数（`prepare*`），所以那几张卡
// 依赖本目录，却不会给本域添命令。
//
// 域内分层（左边一列是 Rust 侧的对应文件）：
//   types.ts / fileSnapshot.ts / buildChangeSet.ts / parseChangeSet.ts   ← _types.rs
//   entryPaths.ts / entryStore.ts                                        ← _store.rs
//   journalDirectory.ts                                                  ← journal_dir()
//   prepare.ts                                                           ← _prepare.rs
//   pathProbe.ts / pathOpsCopy.ts / pathOpsFingerprint.ts / pathOpsMove.ts ← _path_ops.rs
//   recordedPath.ts / snapshotIo.ts                                      ← _snapshot.rs
//   revertResult.ts / revertPlan.ts / revertExecute.ts / revertChangeSet.ts ← _revert.rs
//   batchOverlapGuard.ts / batchSimulation.ts / reapplyChangeSet.ts /
//     revertChangeSets.ts                                                ← _batch.rs
//   revertWorkspaceChangeHandler.ts                                      ← 命令体
//
// 纯逻辑与 IO 分住不同文件（`batchOverlapGuard` / `revertResult` / `fileSnapshot` /
// `buildChangeSet` / `parseChangeSet` 一行 IO 都没有），是为了 W16 的跨语言对拍能不建临时目录树
// 就喂 fixture。

import { createRevertWorkspaceChangeHandler } from './revertWorkspaceChangeHandler'
import type { NodeHostInvokeOptions } from '../../hostOptions'
import type { NodeHostRouteTable } from '../../routeTable'

export function createChangeRoutes(options: NodeHostInvokeOptions): NodeHostRouteTable {
  return {
    revert_workspace_change: createRevertWorkspaceChangeHandler(options),
  }
}
