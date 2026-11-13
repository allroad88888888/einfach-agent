// Wire inputs for recoverable filesystem mutations. Permissions are runtime-only.
import type { WorkspaceChangeContextArgs, WorkspacePatchOperationArgs } from '../commandPayloads'

export interface WorkspaceMutationCommandArgs {
  // ── workspace/write ── Rust: workspace_write.rs；TS: runtime/workspaceWrite.ts 的 toTauriInput
  write_workspace_file: {
    path: string
    content: string
    /** 'overwrite' | 'append' | 'create'；Rust 侧收 String 后自校验，不是闭合 enum。 */
    mode?: string
    expected_old_content?: string
    expected_content_hash?: string
    create_dirs?: boolean
    max_bytes?: number
    exclusive_path_lock?: boolean
    workspace_root?: string
    full_local_access?: boolean
    encoding?: string
    executable?: boolean
    dry_run?: boolean
    change_context?: WorkspaceChangeContextArgs
    /** 只用于日志关联，不影响写入语义；core 侧恒会传（缺省时自己造一个）。 */
    diagnostic_operation_id?: string
  }

  // ── workspace/patch ── Rust: workspace_patch.rs；TS: runtime/workspacePatch.ts
  apply_workspace_patch: {
    operations: readonly WorkspacePatchOperationArgs[]
    dry_run?: boolean
    workspace_root?: string
    full_local_access?: boolean
    change_context?: WorkspaceChangeContextArgs
    diagnostic_operation_id?: string
  }

  // ── workspace/change ── Rust: workspace_change_journal.rs；TS: runtime/workspaceChange.ts
  /** `change_set_id` 与 `change_set_ids` 二选一：单笔回滚 vs 批量回滚。 */
  revert_workspace_change: {
    change_set_id?: string
    change_set_ids?: readonly string[]
    dry_run?: boolean
    workspace_root?: string
    full_local_access?: boolean
  }

  // ── workspace/delete ── Rust: workspace_delete.rs；TS: runtime/workspaceDelete.ts
  delete_workspace_path: {
    path: string
    recursive?: boolean
    workspace_root?: string
    full_local_access?: boolean
    change_context?: WorkspaceChangeContextArgs
  }

  // ── workspace/pathOps ── Rust: workspace_path_ops.rs；TS: runtime/workspacePathOperation.ts
  //    两条命令入参完全一致：core 侧是同一个 operate() 用 `${operation}_workspace_path` 拼名字。
  copy_workspace_path: {
    source: string
    destination: string
    workspace_root?: string
    full_local_access?: boolean
    change_context?: WorkspaceChangeContextArgs
  }
  move_workspace_path: WorkspaceMutationCommandArgs['copy_workspace_path']

}
