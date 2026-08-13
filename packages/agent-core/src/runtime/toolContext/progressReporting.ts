// runtime/toolContext/progressReporting.ts —— 工具进度上报：文案格式化 + 瞬态 activity 写入。
// progress 写会话 store 的 toolActivityAtom，守卫（ghost + 已取消）逐字沿用拆分前的内联判断。

import type { ToolContext } from '../../tools/types'
import { upsertToolActivity } from '../../state/transientAtoms'
import type { CoreInstance } from '../core/coreInstance'
import { isCurrentRun, type CurrentRunDeps } from '../shared/runGuards'

export function shellProgressText(command: string): string {
  const preview = command.replace(/\s+/g, ' ').trim()
  return `执行 shell: ${preview ? preview.slice(0, 120) : '(empty command)'}`
}

export function pathProgressText(action: string, path: unknown): string {
  const value = typeof path === 'string' && path.trim() ? path.trim() : '.'
  return `${action}: ${value.slice(0, 160)}`
}

export function taskProgressText(kind: unknown): string {
  const value = typeof kind === 'string' && kind.trim() ? kind.trim() : 'task'
  return `运行任务: ${value.slice(0, 80)}`
}

export function createProgressReporter(deps: {
  sessionId: string
  callId: string
  toolName: string
  signal: AbortSignal
  currentRun: CurrentRunDeps
  core: CoreInstance
}): ToolContext['progress'] {
  const { sessionId, callId, toolName, signal, currentRun, core } = deps
  return (text) => {
    // 迟到/被顶掉的 run 不写进度；esc 已断也不写。
    if (signal.aborted || !isCurrentRun(currentRun)) return
    upsertToolActivity(sessionId, { callId, toolName, text }, core)
  }
}
