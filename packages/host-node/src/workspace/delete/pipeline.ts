// 删除主流水线：解析 → 六道拒绝 → 记账删除
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_delete.rs 的 `delete_workspace_path_blocking`。
// 记账与执行那一段在 journaledRemoval.ts；本文件只负责「该不该删」，一条都不碰盘地拒绝。
//
// ═══ 顺序（每一步的位置都决定同一个坏输入报哪句话，别按直觉重排）═══
//  1. 解析 workspace root。失败时回执里的 `path` 还是调用方**原样传入**的串。
//  2. 解析目标路径（逐段拒软链、拒 `..`、拒 root 自己）→ 拿到 `displayPath`，此后回执里都用它。
//  3. `lstat` 目标：不存在 / 读不到各有各的文案。
//  4. 目标本身是软链 → 拒。
//  5. 目录但没给 `recursive` → 拒。**排在 `.git` 之前**，所以 `delete_workspace_path(".git")`
//     不带 recursive 时报的是「需要 recursive」而不是「拒绝 Git 元数据」。照搬。
//  6. `.git` 及其子孙 → 拒。
//  7. 预扫整棵树（体量上限 + 树里不许有软链）。
//  8. 没有 `change_context` → 拒。**这一步在最后**：先把所有「无论如何都删不了」的理由说完，
//     再要求调用方补上审计上下文。
//
// ═══ 第 8 条：没有账就不删，没有「不记账的直接删」这个档位 ═══
// write 域允许不带 `change_context` 的一次性写入（明确的、不可回滚的直接写）。删除侧**没有**这个
// 口子：写入的最坏情况是旧内容没了，而用户手里还有新内容；删除的最坏情况是那份内容从世界上消失。
// 所以缺上下文时是 `ok: false`，不是「照删但 reversible: false」。

import { lstat } from 'node:fs/promises'
import { errorText, relativeToRoot, resolveWorkspaceRoot } from '../common'
import { inspectDeleteTree } from './inspectTree'
import { removeWithJournal } from './journaledRemoval'
import { DeleteRejection, errorResult, rejectDelete, successResult } from './result'
import { resolveDeleteTarget } from './targetPath'
import type { Stats } from 'node:fs'
import type { WorkspaceChangeContext } from '../change/types'
import type { WorkspaceDeleteResult } from './result'

/** 收窄之后的入参（字段名转成 camelCase；线上的 snake_case 只活到 handler 那一层）。 */
export interface DeleteWorkspacePathRequest {
  path: string
  recursive?: boolean
  workspaceRoot?: string
  changeContext?: WorkspaceChangeContext
}

/**
 * 跑一次 `delete_workspace_path`。
 *
 * **按设计的拒绝一律是 `ok: false` 的回执，不是 rejection**：模型要能读到那句话并照着改。
 * 非 `DeleteRejection` 的异常原样上抛（那是宿主自己的 bug，该响亮地失败）。
 */
export async function deleteWorkspacePath(
  request: DeleteWorkspacePathRequest,
  journalDirectory: string,
): Promise<WorkspaceDeleteResult> {
  // 路径解析成功之前，回执里的 path 就是调用方原样传入的串。
  let reportedPath = request.path
  try {
    const root = await resolveRoot(request.workspaceRoot)
    const target = await resolveTarget(root, request.path)
    // `relativeToRoot` 对「路径就是 root」给 `"."`，而 Rust 的 `relative_path` 给空串——这处差异
    // 不可达：`resolveDeleteTarget` 已经把 root 自己拒掉了。
    const displayPath = relativeToRoot(root, target)
    reportedPath = displayPath

    const stats = await inspectTarget(target)
    if (stats.isSymbolicLink()) {
      rejectDelete('symbolic links are not supported by recoverable delete')
    }
    const directory = stats.isDirectory()
    if (directory && !(request.recursive ?? false)) {
      rejectDelete('directory deletion requires recursive=true')
    }
    if (isGitMetadata(displayPath)) rejectDelete('recoverable delete refuses Git metadata')
    await inspectTree(target)

    const context = request.changeContext
    if (!context) rejectDelete('recoverable delete requires runtime change context')

    const changeSet = await removeWithJournal({
      journalDirectory,
      context,
      workspaceRoot: root,
      displayPath,
      target,
      directory,
    })
    return successResult(displayPath, directory ? 'directory' : 'file', changeSet)
  } catch (error) {
    if (error instanceof DeleteRejection) return errorResult(reportedPath, error.message)
    throw error
  }
}

/**
 * `.git` 目录本身及其中任何东西。
 *
 * 判据是**展示路径**（根相对、`/` 分隔），所以三平台同一条判定。可恢复删除拒绝碰它，是因为
 * 「把 .git 整份复制进载荷再删掉」即使技术上做得到，回滚时也还原不出一个可用的仓库状态
 * （索引锁、packed-refs、reflog 的时序都对不上），而模型看到的却是一句「已恢复」。
 */
function isGitMetadata(displayPath: string): boolean {
  return displayPath === '.git' || displayPath.startsWith('.git/')
}

/** root 与目标路径的失败原样折进回执（Rust 同样是 `error_result(&path, err)`，不改写文案）。 */
async function resolveRoot(explicit: string | undefined): Promise<string> {
  try {
    return await resolveWorkspaceRoot(explicit)
  } catch (error) {
    return rejectDelete(errorText(error))
  }
}

async function resolveTarget(root: string, requested: string): Promise<string> {
  try {
    return await resolveDeleteTarget(root, requested)
  } catch (error) {
    return rejectDelete(errorText(error))
  }
}

/**
 * 目标的元数据。**不跟随软链**（`lstat`）——要判的是「这条路径本身是什么」，跟随了就永远看不见
 * 软链。「不存在」与「读不到」分成两句话：前者调用方改路径就好，后者是权限或文件系统的问题。
 */
async function inspectTarget(target: string): Promise<Stats> {
  try {
    return await lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return rejectDelete('path does not exist')
    }
    return rejectDelete(`failed to inspect path: ${errorText(error)}`)
  }
}

async function inspectTree(target: string): Promise<void> {
  try {
    await inspectDeleteTree(target)
  } catch (error) {
    rejectDelete(errorText(error))
  }
}
