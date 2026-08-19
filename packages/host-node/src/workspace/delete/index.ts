// workspace/delete 域的 registrar：`delete_workspace_path`
// ---------------------------------------------------------------------------
// 每个域一个 registrar，形状固定：`create<Domain>Routes(options) => NodeHostRouteTable`
// （样板见 src/config/index.ts）。本域只有一条命令，而它是全仓库唯一「会让用户文件消失」的
// 入口，所以实现按 Rust 侧同一套分工摊开（左边一列是 Rust 侧 `workspace_delete.rs` 里的对应
// 函数——那 461 行在 Rust 里是一个文件，Node 侧按职责拆成六个）：
//
//   limits.ts                     ← MAX_ENTRIES / MAX_BYTES 两个常量与按它们做的判定（纯）
//   inspectTree.ts                ← inspect_tree
//   targetPath.ts                 ← resolve_delete_path + relative_path
//   result.ts                     ← WorkspaceDeleteResult + error_result（纯）
//   journaledRemoval.ts           ← prepare → copy → remove → mark 那一段与它的三处补偿
//   pipeline.ts                   ← delete_workspace_path_blocking 的编排与六道拒绝
//   deleteWorkspacePathHandler.ts ← 命令体（serde 那一层 + journal_dir）
//
// 纯逻辑与 IO 分住不同文件（`limits` / `result` 一行 IO 都没有），是为了 W16 的跨语言对拍能
// 不建临时目录树就喂 fixture。
//
// **本域不提供「不记账的直接删」**：`change_context` 缺席是 `ok: false`，不是照删。理由见
// pipeline.ts 顶部与 limits.ts 顶部——删除的最坏情况与写入的不是一个量级。

import { createDeleteWorkspacePathHandler } from './deleteWorkspacePathHandler'
import type { NodeHostInvokeOptions } from '../../hostOptions'
import type { NodeHostRouteTable } from '../../routeTable'

export function createDeleteRoutes(options: NodeHostInvokeOptions): NodeHostRouteTable {
  return {
    delete_workspace_path: createDeleteWorkspacePathHandler(options),
  }
}
