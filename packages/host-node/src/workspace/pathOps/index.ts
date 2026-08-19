// workspace/pathOps 域的 registrar：`copy_workspace_path` / `move_workspace_path`
// ---------------------------------------------------------------------------
// 每个域一个 registrar，形状固定：`create<Domain>Routes(options) => NodeHostRouteTable`
// （样板见 src/config/index.ts）。两条命令在 Rust 侧共用同一个 `operate()` 实现，本域同样只有
// 一套核心逻辑，两个 handler 只是绑了不同的 `operation` 参数：
//
//   resolveTarget.ts   ← workspace_path_ops.rs 的 clean_relative / resolve_source /
//                          resolve_destination / relative（**这四个是本文件专属的解析规则**，
//                          比读/写两种通用形态更严格，见该文件文件头）
//   result.ts          ← `WorkspacePathOperationResult`（camelCase，无 skip_serializing_if）
//   pipeline.ts         ← `operate()`：解析 → 记账 → 落盘 → 收尾
//   pathOpsHandler.ts   ← 两条命令的命令体（入参收窄 + handler 工厂）
//
// 记账（`prepareCreatedPathChange` / `prepareRelocatedPathChange` / `markChangeApplied` /
// `discardPreparedChange`）与原语（`copyPath` / `movePath` / `pathFingerprint`）都已经在
// `../change/` 里（W14），本域只负责编排与命令层的收窄。

import { createCopyWorkspacePathHandler, createMoveWorkspacePathHandler } from './pathOpsHandler'
import type { NodeHostInvokeOptions } from '../../hostOptions'
import type { NodeHostRouteTable } from '../../routeTable'

export function createPathOpsRoutes(options: NodeHostInvokeOptions): NodeHostRouteTable {
  return {
    copy_workspace_path: createCopyWorkspacePathHandler(options),
    move_workspace_path: createMoveWorkspacePathHandler(options),
  }
}
