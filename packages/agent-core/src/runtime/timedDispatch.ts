import { isAbortError } from '@web-agent/ai'
import type { ToolCallTiming } from '../tools/toolCallTiming'
import type { Tool, ToolResult } from '../tools/types'
import type { ToolRegistry } from '../tools/toolRegistry'
import type { CoreInstance } from './core/coreInstance'
import type { ToolLoopCheckpointWriter } from './toolLoopCheckpoint'
import type { ToolLoopBase } from './toolLoopContracts'
import { newId } from './newId'

export interface TimedToolRegistration {
  name: string
  registrationVersion: number
  runtime: Tool['runtime']
}

export interface TimedToolDispatchRequest {
  sessionId: string
  timing: ToolCallTiming
}

export interface TimedToolDispatchResult {
  status: 'dispatched' | 'no_active_run' | 'inactive'
  itemCount: number
}

/** Supplies a timeline-specific adapter while sharing timing-bucket dispatch semantics. */
export interface TimedToolDispatchAdapter {
  registrations: readonly TimedToolRegistration[]
  isCurrent(): boolean
  createCallId(name: string): string
  canDispatch?(registration: TimedToolRegistration): boolean
  isRecorded?(callId: string, registration: TimedToolRegistration): boolean
  execute(registration: TimedToolRegistration, callId: string): Promise<ToolResult>
  record(registration: TimedToolRegistration, callId: string, result: ToolResult): Promise<void> | void
  isAbortError?(error: unknown): boolean
  errorMessage?(error: unknown): string
  onFailure?(input: { registration: TimedToolRegistration; callId: string; error: string }): void
}

interface TimedDispatchDependencies {
  itemsAtom: typeof import('../state/sessionAtoms').itemsAtom
  sessionsAtom: typeof import('../state/rootStore').sessionsAtom
  workspacesAtom: typeof import('../state/rootStore').workspacesAtom
  resolveSessionWorkspaceRoot: typeof import('../state/workspaceState').resolveSessionWorkspaceRoot
  classifyToolRisk: typeof import('./dangerousTools').classifyToolRisk
  executeToolCall: typeof import('./toolCallExecutor').executeToolCall
  appendMappedToolResult: typeof import('./toolLoopSupport').appendMappedToolResult
  safeErrorMessage: typeof import('./toolLoopSupport').safeErrorMessage
}

async function loadTimedDispatchDependencies(): Promise<TimedDispatchDependencies> {
  const [
    sessionAtoms,
    rootStore,
    workspaceState,
    dangerousTools,
    toolCallExecutor,
    toolLoopSupport,
  ] = await Promise.all([
    import('../state/sessionAtoms'),
    import('../state/rootStore'),
    import('../state/workspaceState'),
    import('./dangerousTools'),
    import('./toolCallExecutor'),
    import('./toolLoopSupport'),
  ])
  return {
    itemsAtom: sessionAtoms.itemsAtom,
    sessionsAtom: rootStore.sessionsAtom,
    workspacesAtom: rootStore.workspacesAtom,
    resolveSessionWorkspaceRoot: workspaceState.resolveSessionWorkspaceRoot,
    classifyToolRisk: dangerousTools.classifyToolRisk,
    executeToolCall: toolCallExecutor.executeToolCall,
    appendMappedToolResult: toolLoopSupport.appendMappedToolResult,
    safeErrorMessage: toolLoopSupport.safeErrorMessage,
  }
}

/** Keeps each callTiming bucket in the registry's insertion order without exposing timed tools to models. */
export function createTimedToolRegistry(registry: ToolRegistry): {
  tools: ToolRegistry
  registrations(timing: ToolCallTiming): readonly TimedToolRegistration[]
} {
  const timedNames = new Map<ToolCallTiming, string[]>()
  const timingByName = new Map<string, ToolCallTiming>()
  const runtimeByName = new Map<string, Tool['runtime']>()
  const registrationOrder = new Map<string, number>()
  let nextRegistrationOrder = 0

  function removeTimedName(name: string, timing: ToolCallTiming | undefined): void {
    if (!timing) return
    const names = timedNames.get(timing)
    if (!names) return
    const index = names.indexOf(name)
    if (index >= 0) names.splice(index, 1)
    if (names.length === 0) timedNames.delete(timing)
  }

  function addTimedName(name: string, timing: ToolCallTiming | undefined): void {
    if (!timing) return
    const names = timedNames.get(timing) ?? []
    const order = registrationOrder.get(name)!
    const index = names.findIndex((candidate) => registrationOrder.get(candidate)! > order)
    if (index < 0) names.push(name)
    else names.splice(index, 0, name)
    timedNames.set(timing, names)
  }

  const tools: ToolRegistry = {
    ...registry,
    register(tool: Tool) {
      const existed = registry.has(tool.name)
      const previousTiming = registry.callTiming(tool.name)
      registry.register(tool)
      const timing = registry.callTiming(tool.name)
      if (!existed) registrationOrder.set(tool.name, nextRegistrationOrder++)
      if (timing) runtimeByName.set(tool.name, tool.runtime)
      else runtimeByName.delete(tool.name)
      if (previousTiming === timing) return
      removeTimedName(tool.name, previousTiming)
      if (timing) timingByName.set(tool.name, timing)
      else timingByName.delete(tool.name)
      addTimedName(tool.name, timing)
    },
    unregister(name, expected) {
      const timing = timingByName.get(name)
      const removed = registry.unregister(name, expected)
      if (!removed) return false
      removeTimedName(name, timing)
      timingByName.delete(name)
      runtimeByName.delete(name)
      registrationOrder.delete(name)
      return true
    },
  }

  return {
    tools,
    registrations(timing) {
      const names = timedNames.get(timing)
      if (!names) return []
      return names.flatMap((name) => {
        const registrationVersion = tools.registrationVersion(name)
        const runtime = runtimeByName.get(name)
        return registrationVersion === undefined || !runtime || tools.callTiming(name) !== timing
          ? []
          : [{ name, registrationVersion, runtime }]
      })
    },
  }
}

function isDispatchCurrent(base: ToolLoopBase): boolean {
  return base.control.isCurrent() && !base.opts.signal.aborted
}

function timedCallId(base: ToolLoopBase, timing: ToolCallTiming, name: string): string {
  if (timing === 'sessionStart') return `timed:${timing}:${name}`
  if (timing === 'runStart' || timing === 'runEnd') return `timed:${timing}:${base.runId}:${name}`
  return `timed:${timing}:${base.runId}:${newId()}:${name}`
}

function timedItemAlreadyRecorded(
  base: ToolLoopBase,
  callId: string,
  dependencies: TimedDispatchDependencies,
): boolean {
  return base.core.getSessionStore(base.id).store.getter(dependencies.itemsAtom).some((entry) => (
    entry.item.role === 'tool' && entry.item.tool_call_id === callId
  ))
}

function persistTimedItems(base: ToolLoopBase, checkpoints: ToolLoopCheckpointWriter): void {
  if (!isDispatchCurrent(base)) return
  checkpoints.persistWorkingTurn()
}

function riskForTimedTool(
  input: { core: CoreInstance; sessionId: string; name: string },
  dependencies: TimedDispatchDependencies,
) {
  const session = input.core.rootStore.getter(dependencies.sessionsAtom)[input.sessionId]
  const workspaceRoot = dependencies.resolveSessionWorkspaceRoot(
    session,
    input.core.rootStore.getter(dependencies.workspacesAtom),
  )
  return dependencies.classifyToolRisk(input.name, {}, {
    workspaceRoot,
    mcpConnectTarget: input.core.config.mcpConnectTarget,
    mcpToolLaunchTarget: input.core.config.mcpToolLaunchTarget,
  })
}

/** Classifies a timed tool without entering confirmation hooks or executing it. */
export async function classifyTimedToolRisk(input: {
  core: CoreInstance
  sessionId: string
  name: string
}) {
  return riskForTimedTool(input, await loadTimedDispatchDependencies())
}

function fallbackErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Dispatches registrations in registration order and degrades individual failures into results.
 * Different timelines supply execution and persistence through the adapter rather than duplicating this loop.
 */
export async function dispatchTimedToolRegistrations(
  adapter: TimedToolDispatchAdapter,
): Promise<TimedToolDispatchResult> {
  if (!adapter.isCurrent()) return { status: 'inactive', itemCount: 0 }
  let itemCount = 0
  for (const registration of adapter.registrations) {
    if (!adapter.isCurrent()) return { status: 'inactive', itemCount }
    if (adapter.canDispatch && !adapter.canDispatch(registration)) continue
    const callId = adapter.createCallId(registration.name)
    if (adapter.isRecorded?.(callId, registration)) continue
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
    itemCount += 1
  }
  return { status: 'dispatched', itemCount }
}

/** Dispatches one timing bucket through the normal executor, never through beforeToolCall confirmation hooks. */
export async function dispatchTimedTools(input: {
  base: ToolLoopBase
  checkpoints: ToolLoopCheckpointWriter
  request: TimedToolDispatchRequest
}): Promise<TimedToolDispatchResult> {
  const { base, checkpoints, request } = input
  if (request.sessionId !== base.id || !isDispatchCurrent(base)) {
    return { status: 'inactive', itemCount: 0 }
  }
  const registrations = base.core.timedToolRegistrations(request.timing)
  if (registrations.length === 0) return { status: 'dispatched', itemCount: 0 }
  const dependencies = await loadTimedDispatchDependencies()
  if (!isDispatchCurrent(base)) return { status: 'inactive', itemCount: 0 }

  return dispatchTimedToolRegistrations({
    registrations,
    isCurrent: () => isDispatchCurrent(base),
    createCallId: (name) => timedCallId(base, request.timing, name),
    isRecorded: (callId) => (
      (request.timing === 'sessionStart' || request.timing === 'runStart' || request.timing === 'runEnd')
      && timedItemAlreadyRecorded(base, callId, dependencies)
    ),
    execute: async ({ name, registrationVersion }, callId) => {
      const risk = riskForTimedTool({ core: base.core, sessionId: base.id, name }, dependencies)
      if (risk.level !== 'safe') {
        const error = `到点工具 ${name} 因风险等级 ${risk.level} 被拒绝执行`
        base.trace.event('tool.timed_rejected', {
          timing: request.timing,
          toolName: name,
          callId,
          risk: risk.level,
          reason: risk.reason,
        })
        return { ok: false, error, details: { timing: request.timing, risk: risk.level } }
      }
      return dependencies.executeToolCall(base, { callId, name, args: {}, registrationVersion })
    },
    record: (_registration, callId, result) => {
      dependencies.appendMappedToolResult(base.id, callId, result, base.core)
      persistTimedItems(base, checkpoints)
    },
    isAbortError: (error) => isAbortError(error),
    errorMessage: dependencies.safeErrorMessage,
    onFailure: ({ registration, callId, error }) => {
      base.trace.event('tool.timed_failed', {
        timing: request.timing,
        toolName: registration.name,
        callId,
        error,
      })
    },
  })
}
