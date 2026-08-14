import { isAbortError } from '@web-agent/ai'
import type { ToolResult } from '../tools/types'
import type { TraceAttributes, TraceStatus } from '../observability/port'
import { appendItem } from '../state/sessionWriters'
import { newId } from './newId'
import { isCurrentRun } from './shared/runGuards'
import type { CoreInstance } from './core/coreInstance'
import { runAtom } from '../state/sessionAtoms'
import { setToolCallOutcomeFacts } from './toolCallOutcomeFacts'

const SHELL_TOOLS_REQUIRING_COMMAND = new Set(['shell_macos', 'shell_linux', 'shell_powershell'])
const ARGS_PREVIEW_LIMIT = 200

/** Describes the active run without retaining a module-global store. */
export function createRunGuard(id: string, runId: string, core: CoreInstance) {
  return { root: core.rootStore, getStore: () => core.getSessionStore(id).store, sessionId: id, runId }
}

export function isRunningRun(id: string, runId: string, core: CoreInstance): boolean {
  const guard = createRunGuard(id, runId, core)
  return isCurrentRun(guard) && guard.getStore().getter(runAtom)?.status === 'running'
}

export function abortStatus(signal: AbortSignal, error?: unknown): Exclude<TraceStatus, 'running'> {
  return signal.aborted || isAbortError(error) ? 'cancelled' : 'error'
}

export function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function argsPreviewForModel(raw: string): string {
  return raw.length > ARGS_PREVIEW_LIMIT ? `${raw.slice(0, ARGS_PREVIEW_LIMIT)}...` : raw
}

export function toolCallValidationError(name: string, args: Record<string, unknown>): string | undefined {
  if (!SHELL_TOOLS_REQUIRING_COMMAND.has(name)) return undefined
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  return command ? undefined : `invalid ${name}: command (non-empty string) is required`
}

export function questionCount(payload: unknown): number | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const questions = (payload as { questions?: unknown }).questions
  return Array.isArray(questions) ? questions.length : undefined
}

export function toolResultTrace(result: ToolResult, args?: unknown): {
  status: Exclude<TraceStatus, 'running'>
  attrs: TraceAttributes
  err?: unknown
} {
  const baseAttrs: TraceAttributes = args === undefined ? {} : { args }
  if ('pause' in result) return { status: 'ok', attrs: { ...baseAttrs, result_kind: 'pause', result: result.pause, question_count: questionCount(result.pause) } }
  if (result.ok) return { status: 'ok', attrs: { ...baseAttrs, result_kind: result.data === null ? 'null' : Array.isArray(result.data) ? 'array' : typeof result.data, result: result.data ?? { ok: true } } }
  return {
    status: 'error',
    attrs: {
      ...baseAttrs,
      result_kind: 'error',
      result: { error: result.error, ...(result.code ? { code: result.code } : {}), ...(result.hint ? { hint: result.hint } : {}), ...(result.retryable !== undefined ? { retryable: result.retryable } : {}), ...(result.details !== undefined ? { details: result.details } : {}) },
      error: result.error,
    },
    err: result.error,
  }
}

/** Appends one protocol-required tool result to the conversation transcript. */
export function appendToolResult(id: string, toolCallId: string, content: string, core: CoreInstance, planStageId?: string): void {
  appendItem(id, {
    id: newId(),
    createdAt: Date.now(),
    ...(planStageId !== undefined ? { planStageId } : {}),
    item: { role: 'tool', tool_call_id: toolCallId, content },
  }, core)
  setToolCallOutcomeFacts(id, [toolCallId], 'outcomeKnown', core)
  void core.persistence.persistRecovery(id, 'tool_call_result_saved')
}

/** Serializes a runtime tool result in the same shape that the model API receives. */
export function appendMappedToolResult(id: string, toolCallId: string, result: ToolResult, core: CoreInstance, planStageId?: string): void {
  if ('pause' in result) appendToolResult(id, toolCallId, JSON.stringify({ error: 'unexpected pause' }), core, planStageId)
  else if (result.ok) {
    const data = result.data ?? { ok: true }
    appendToolResult(id, toolCallId, JSON.stringify(result.warnings?.length ? { data, warnings: result.warnings } : data), core, planStageId)
  } else appendToolResult(id, toolCallId, JSON.stringify({ error: result.error, ...(result.code ? { code: result.code } : {}), ...(result.hint ? { hint: result.hint } : {}), ...(result.retryable !== undefined ? { retryable: result.retryable } : {}), ...(result.details !== undefined ? { details: result.details } : {}) }), core, planStageId)
}
