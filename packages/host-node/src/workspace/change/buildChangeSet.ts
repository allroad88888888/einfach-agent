// 由一次工具调用的事实组装出条目对象
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_change_journal_prepare.rs（已随 T1 删除）里三个 `prepare_*` 共用的那段
// `WorkspaceChangeSet { ... }` 字面量。
//
// 单独成文件、且**收时钟作为入参**，是为了让它是纯函数：喂同样的输入必然得到同一份字节。
// W16 的跨语言对拍靠这条——它要能把 Rust 写出来的条目和 Node 写出来的条目逐字节比，而不是绕开
// 内容只比「有没有写成功」。时钟留在 prepare.ts（IO 那一侧）读。
//
// 字段的书写顺序**必须**与 types.ts 的声明顺序一致：serde 按声明顺序输出，`JSON.stringify` 按
// 插入顺序输出，两边对齐了条目才逐字节相同。

import { fileSnapshotFromContent } from './fileSnapshot'
import type {
  ChangeFileInput,
  MovedPath,
  RelocatedPath,
  TrackedPath,
  WorkspaceChangeContext,
  WorkspaceChangeSet,
} from './types'

export interface ChangeSetDraft {
  context: WorkspaceChangeContext
  /** canonicalize 之后的 workspace root。回滚时逐字比对，所以这里存什么、那里就得算出什么。 */
  workspaceRoot: string
  /** epoch 纳秒。由调用方给，见文件头。 */
  createdAt: number
  files?: readonly ChangeFileInput[]
  movedPaths?: readonly MovedPath[]
  createdPaths?: readonly TrackedPath[]
  relocatedPaths?: readonly RelocatedPath[]
}

/**
 * 组装一份 `prepared` 状态的条目。
 *
 * 四个账目数组是并列的四种改动形态，一次登记只会用到其中一种（整文件改写 / 删除 / 新建 / 移动），
 * 其余写成空数组——**不是省略**：Rust 侧的 `#[serde(default)]` 让读取端容忍缺键，但写入端始终把
 * 四个都写出来，两个宿主的条目形状因此完全一致。
 */
export function buildChangeSet(draft: ChangeSetDraft): WorkspaceChangeSet {
  return {
    id: draft.context.changeId,
    sessionId: draft.context.sessionId,
    runId: draft.context.runId,
    toolCallId: draft.context.toolCallId,
    workspaceRoot: draft.workspaceRoot,
    createdAt: draft.createdAt,
    status: 'prepared',
    files: (draft.files ?? []).map((file) => ({
      path: file.path,
      before: fileSnapshotFromContent(file.before),
      after: fileSnapshotFromContent(file.after),
    })),
    movedPaths: (draft.movedPaths ?? []).map((item) => ({ path: item.path })),
    createdPaths: (draft.createdPaths ?? []).map((item) => ({
      path: item.path,
      fingerprint: item.fingerprint,
    })),
    relocatedPaths: (draft.relocatedPaths ?? []).map((item) => ({
      source: item.source,
      destination: item.destination,
      fingerprint: item.fingerprint,
    })),
  }
}
