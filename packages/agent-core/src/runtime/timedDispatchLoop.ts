import type { ToolResult } from '../tools/types'
import type { TimedToolRegistration } from './timedDispatch'

export interface TimedToolDispatchResult {
  status: 'dispatched' | 'no_active_run' | 'inactive' | 'interrupted'
  itemCount: number
}

/** Supplies a timeline-specific adapter while sharing timing-bucket dispatch semantics. */
export interface TimedToolDispatchAdapter {
  registrations: readonly TimedToolRegistration[]
  isCurrent(): boolean
  createCallId(name: string): string
  canDispatch?(registration: TimedToolRegistration): boolean
  isRecorded?(callId: string, registration: TimedToolRegistration): boolean
  requiresReconciliation?(registration: TimedToolRegistration, callId: string): boolean
  beforeExecute?(registration: TimedToolRegistration, callId: string): Promise<boolean> | boolean
  execute(registration: TimedToolRegistration, callId: string): Promise<ToolResult>
  record(registration: TimedToolRegistration, callId: string, result: ToolResult): Promise<void> | void
  afterRecord?(registration: TimedToolRegistration, callId: string, result: ToolResult): Promise<boolean> | boolean
  isAbortError?(error: unknown): boolean
  errorMessage?(error: unknown): string
  onFailure?(input: { registration: TimedToolRegistration; callId: string; error: string }): void
}

function fallbackErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Runs a timing bucket while allowing each timeline to fence its own side effects. */
export async function dispatchTimedToolRegistrations(
  adapter: TimedToolDispatchAdapter,
): Promise<TimedToolDispatchResult> {
  if (!adapter.isCurrent()) return { status: 'inactive', itemCount: 0 }
  let itemCount = 0
  for (const registration of adapter.registrations) {
    if (!adapter.isCurrent()) return { status: 'inactive', itemCount }
    const callId = adapter.createCallId(registration.name)
    if (adapter.requiresReconciliation?.(registration, callId)) return { status: 'interrupted', itemCount }
    if (adapter.isRecorded?.(callId, registration)) continue
    if (adapter.canDispatch && !adapter.canDispatch(registration)) continue
    if (adapter.beforeExecute && !await adapter.beforeExecute(registration, callId)) {
      return { status: 'interrupted', itemCount }
    }
    if (!adapter.isCurrent()) return { status: 'inactive', itemCount }
    let result: ToolResult
    try {
      result = await adapter.execute(registration, callId)
    } catch (error) {
      if (adapter.isAbortError?.(error) || !adapter.isCurrent()) {
        return { status: 'inactive', itemCount }
      }
      const message = adapter.errorMessage?.(error) ?? fallbackErrorMessage(error)
      adapter.onFailure?.({ registration, callId, error: message })
      result = { ok: false, error: message }
    }
    if (!adapter.isCurrent()) return { status: 'inactive', itemCount }
    await adapter.record(registration, callId, result)
    if (!adapter.isCurrent()) return { status: 'inactive', itemCount }
    itemCount += 1
    if (adapter.afterRecord && !await adapter.afterRecord(registration, callId, result)) {
      return { status: 'interrupted', itemCount }
    }
    if (!adapter.isCurrent()) return { status: 'inactive', itemCount }
  }
  return { status: 'dispatched', itemCount }
}
