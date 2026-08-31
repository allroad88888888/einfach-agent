// runtime/toolContext/workspaceCapabilities.ts —— ctx 上的 shell / 文件 / Git / 任务副作用能力。
// 每个能力都是同一条流水线：assertFresh → progress → 经 workspaceInputGuards 装饰入参 → 调桥 →
// 再 assertFresh。守卫与装饰顺序逐字沿用拆分前的 buildToolContext，不得为了「简化」改写。

import type { ToolContext } from '../../tools/types'
import { commandUsesPermanentDelete } from '../shellCommandRisk'
import type { CoreInstance } from '../core/coreInstance'
import { runShellCommand } from '../shellCommand'
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  searchWorkspaceFiles,
} from '../workspaceRead'
import { readWorkspaceImage } from '../workspaceImageRead'
import { rgSearchWorkspace } from '../workspaceRg'
import { applyWorkspacePatch } from '../workspacePatch'
import { writeWorkspaceFile } from '../workspaceWrite'
import { deleteWorkspacePath } from '../workspaceDelete'
import { revertWorkspaceChange } from '../workspaceChange'
import { copyWorkspacePath, moveWorkspacePath } from '../workspacePathOperation'
import { getWorkspaceDiff } from '../workspaceGit'
import { runWorkspaceTask } from '../workspaceTask'
import { pathProgressText, shellProgressText, taskProgressText } from './progressReporting'
import type { ToolStaleGuards } from './staleGuards'
import type { WorkspaceInputGuards } from './workspaceInputGuards'

export type WorkspaceCapabilities = Pick<
  ToolContext,
  | 'runShell'
  | 'readWorkspaceFile'
  | 'readWorkspaceImage'
  | 'listWorkspaceFiles'
  | 'searchWorkspaceFiles'
  | 'rgSearchWorkspace'
  | 'applyWorkspacePatch'
  | 'writeWorkspaceFile'
  | 'deleteWorkspacePath'
  | 'copyWorkspacePath'
  | 'moveWorkspacePath'
  | 'revertWorkspaceChange'
  | 'getWorkspaceDiff'
  | 'runWorkspaceTask'
>

export function createWorkspaceCapabilities(deps: {
  toolName: string
  core: CoreInstance
  guards: ToolStaleGuards
  progress: ToolContext['progress']
  inputGuards: WorkspaceInputGuards
}): WorkspaceCapabilities {
  const { toolName, core, progress } = deps
  const { assertFresh } = deps.guards
  const {
    withWorkspaceRoot,
    withWorkspaceReadAccess,
    withChangeContext,
    withShellCwd,
  } = deps.inputGuards

  return {
    async runShell(input) {
      assertFresh()
      progress(shellProgressText(input.command))
      const result = await runShellCommand(withShellCwd(input))
      assertFresh()
      return commandUsesPermanentDelete(toolName, { command: input.command })
        ? { ...result, reversible: false }
        : result
    },

    async readWorkspaceFile(input) {
      assertFresh()
      progress(pathProgressText('读取文件', input.path))
      const result = await readWorkspaceFile(withWorkspaceReadAccess(input))
      assertFresh()
      return result
    },

    async readWorkspaceImage(input) {
      assertFresh()
      progress(pathProgressText('读取图片', input.path))
      const result = await readWorkspaceImage(withWorkspaceReadAccess(input))
      assertFresh()
      if (!result.ok) throw new Error(result.error)
      return result.data
    },

    async listWorkspaceFiles(input) {
      assertFresh()
      progress(pathProgressText('列出文件', input.path))
      const result = await listWorkspaceFiles(withWorkspaceReadAccess(input))
      assertFresh()
      return result
    },

    async searchWorkspaceFiles(input) {
      assertFresh()
      progress(pathProgressText('搜索文件', input.path))
      const result = await searchWorkspaceFiles(withWorkspaceReadAccess(input))
      assertFresh()
      return result
    },

    async rgSearchWorkspace(input) {
      assertFresh()
      progress(pathProgressText('rg 搜索', input.path))
      const result = await rgSearchWorkspace(withWorkspaceReadAccess(input))
      assertFresh()
      return result
    },

    async applyWorkspacePatch(input) {
      assertFresh()
      progress('应用文件 patch')
      const result = await applyWorkspacePatch(
        withChangeContext(
          withWorkspaceRoot(input as Parameters<typeof applyWorkspacePatch>[0]),
        ),
        core.observability,
      )
      assertFresh()
      return result
    },

    async writeWorkspaceFile(input) {
      assertFresh()
      const path = typeof input === 'object' && input && 'path' in input ? (input as { path?: unknown }).path : undefined
      progress(pathProgressText('写入文件', path))
      const result = await writeWorkspaceFile(
        withChangeContext(
          withWorkspaceRoot(input as Parameters<typeof writeWorkspaceFile>[0]),
        ),
        core.observability,
      )
      assertFresh()
      return result
    },

    async deleteWorkspacePath(input) {
      assertFresh()
      const path = typeof input === 'object' && input && 'path' in input
        ? (input as { path?: unknown }).path
        : undefined
      progress(pathProgressText('删除路径', path))
      const result = await deleteWorkspacePath(
        withChangeContext(
          withWorkspaceRoot(input as Parameters<typeof deleteWorkspacePath>[0]),
        ),
      )
      assertFresh()
      return result
    },

    async copyWorkspacePath(input) {
      assertFresh()
      progress('复制路径')
      const result = await copyWorkspacePath(
        withChangeContext(withWorkspaceRoot(input as Parameters<typeof copyWorkspacePath>[0])),
      )
      assertFresh()
      return result
    },

    async moveWorkspacePath(input) {
      assertFresh()
      progress('移动路径')
      const result = await moveWorkspacePath(
        withChangeContext(withWorkspaceRoot(input as Parameters<typeof moveWorkspacePath>[0])),
      )
      assertFresh()
      return result
    },

    async revertWorkspaceChange(input) {
      assertFresh()
      progress('回退文件更改')
      const result = await revertWorkspaceChange(
        withWorkspaceRoot(input as Parameters<typeof revertWorkspaceChange>[0]),
      )
      assertFresh()
      return result
    },

    async getWorkspaceDiff(input) {
      assertFresh()
      progress('读取 Git diff')
      const result = await getWorkspaceDiff(
        withWorkspaceRoot(input as Parameters<typeof getWorkspaceDiff>[0]),
      )
      assertFresh()
      return result
    },

    async runWorkspaceTask(input) {
      assertFresh()
      progress(taskProgressText(input.kind))
      const result = await runWorkspaceTask(withWorkspaceRoot(input))
      assertFresh()
      return result
    },
  }
}
