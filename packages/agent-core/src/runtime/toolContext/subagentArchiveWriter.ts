// runtime/toolContext/subagentArchiveWriter.ts —— 子 agent 归档写入（delegate call context 的 writeTextFile）。
// 归档是审计记录，守卫比普通副作用宽一档：取消后仍要落最终事件（assertArchiveCurrent），但被新 run
// 顶掉的旧 run 一律拒写。写入仍经 workspaceInputGuards 注入会话根目录，不绕开 workspace confinement。

import type { ToolContext } from '../../tools/types'
import type { CoreInstance } from '../core/coreInstance'
import { writeWorkspaceFile, type WorkspaceWriteInput, type WorkspaceWriteResult } from '../workspaceWrite'
import { pathProgressText } from './progressReporting'
import type { ToolStaleGuards } from './staleGuards'
import type { WorkspaceInputGuards } from './workspaceInputGuards'

type ArchiveWriteMode = 'create' | 'overwrite' | 'append' | 'upsert'

interface ArchiveWriteInput {
  path: string
  content: string
  mode?: ArchiveWriteMode
}

export interface SubagentArchiveWriters {
  writeSubagentTextFile(input: ArchiveWriteInput): Promise<unknown>
  /** 阶段验收专用：写失败降级成 warning，不把已产出 verdict 的 evaluator 判成失败。 */
  writeEvaluatorArchiveBestEffort(input: ArchiveWriteInput): Promise<unknown>
}

function assertSubagentWriteSucceeded(
  result: WorkspaceWriteResult,
  path: string,
  mode: ArchiveWriteMode,
): void {
  if (result.ok) return
  const detail = result.error?.trim() || 'unknown workspace write error'
  throw new Error(`Subagent archive write failed (${mode}) for "${path}": ${detail}`)
}

export function createSubagentArchiveWriters(deps: {
  core: CoreInstance
  guards: ToolStaleGuards
  progress: ToolContext['progress']
  inputGuards: Pick<WorkspaceInputGuards, 'withWorkspaceRoot'>
}): SubagentArchiveWriters {
  const { core, progress } = deps
  const { assertArchiveCurrent } = deps.guards
  const { withWorkspaceRoot } = deps.inputGuards

  async function writeSubagentTextFile(input: ArchiveWriteInput): Promise<unknown> {
    assertArchiveCurrent()
    progress(pathProgressText('写入子 agent 归档', input.path))
    // 归档文件是 snapshot 语义：已存在时覆盖，首次落盘时创建。这正是 upsert，
    // 由 Rust 在同一把路径锁内判定，不再需要"先 overwrite 失败再 create"的两次往返。
    const mode = input.mode ?? 'upsert'
    const writeInput = withWorkspaceRoot({
      path: input.path,
      content: input.content,
      mode,
      createDirs: true,
      maxBytes: 2 * 1024 * 1024,
      exclusivePathLock: true,
    } satisfies WorkspaceWriteInput)

    const result = await writeWorkspaceFile(writeInput, core.observability)
    assertArchiveCurrent()
    assertSubagentWriteSucceeded(result, input.path, mode)
    return result
  }

  // 阶段验收的 evaluator 是计划状态机的一部分，归档只是辅助审计记录。
  // Web 环境没有 workspace 写桥，桌面端也可能临时遇到归档目录权限问题；这两类失败都不能
  // 把一个已经产出有效 JSON verdict 的 evaluator 判成失败，否则阶段会永久退回 in_progress。
  // 首次失败后本次 evaluator 不再重复尝试，避免每个事件都撞一次相同的写入错误。
  let evaluatorArchiveUnavailable: string | undefined
  async function writeEvaluatorArchiveBestEffort(input: ArchiveWriteInput): Promise<unknown> {
    if (evaluatorArchiveUnavailable) {
      return { ok: true, skipped: true, warning: evaluatorArchiveUnavailable }
    }
    try {
      return await writeSubagentTextFile(input)
    } catch (error) {
      evaluatorArchiveUnavailable = error instanceof Error ? error.message : String(error)
      progress(`评估器归档已跳过: ${evaluatorArchiveUnavailable}`)
      return { ok: true, skipped: true, warning: evaluatorArchiveUnavailable }
    }
  }

  return { writeSubagentTextFile, writeEvaluatorArchiveBestEffort }
}
