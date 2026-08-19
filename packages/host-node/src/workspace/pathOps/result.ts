// `copy_workspace_path` / `move_workspace_path` 的回执形状
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_path_ops.rs 的 `WorkspacePathOperationResult`。这个 struct
// **带** `#[serde(rename_all = "camelCase")]`，且没有任何 `skip_serializing_if`，所以顶层键是
// camelCase、`error` / `changeSet` 缺席时是显式 `null` 而不是键消失——与 write/result.ts 的
// snake_case 回执（`WorkspaceWriteResult` 没有 `rename_all`）是两种线上形状，各自照抄各自的
// Rust 源，不要为了"看起来统一"互相靠拢。

import type { WorkspaceChangeSummary } from '../change/types'

export type WorkspacePathOperationName = 'copy' | 'move'

export interface WorkspacePathOperationResult {
  ok: boolean
  source: string
  destination: string
  operation: WorkspacePathOperationName
  reversible: boolean
  error: string | null
  changeSet: WorkspaceChangeSummary | null
}

/**
 * 按设计拒绝这次操作。等价 Rust `operate()` 里的 `fail` 闭包：`source` / `destination` 是**调用方
 * 原样传入**的那两个串，不是解析后的路径——路径解析失败时没有"解析后的路径"可言；解析成功后
 * 才失败（比如 markChangeApplied 失败）时同样保留原始输入，因为 Rust 的闭包捕获的是
 * `source_arg.clone()` / `destination_arg.clone()`，全程不重新赋值。
 */
export function failedResult(
  operation: WorkspacePathOperationName,
  source: string,
  destination: string,
  error: string,
): WorkspacePathOperationResult {
  return {
    ok: false,
    source,
    destination,
    operation,
    reversible: false,
    error,
    changeSet: null,
  }
}
