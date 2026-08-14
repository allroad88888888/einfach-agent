import { isAbortError } from '@web-agent/ai'
import type { ToolCallTiming } from '../tools/toolCallTiming'
import type { Tool, ToolResult } from '../tools/types'
import type { ToolRegistry } from '../tools/toolRegistry'
import type { CoreInstance } from './core/coreInstance'
import type { ToolLoopCheckpointWriter } from './toolLoopCheckpoint'
import type { ToolLoopBase } from './toolLoopContracts'
import { runAtom } from '../state/sessionAtoms'
import { patchRun } from '../state/sessionWriters'
import { persistToolCallExecutionFence } from './toolCallExecutionFence'
import { requireRecoveryDurability } from './recoveryDurabilityBarrier'
import { requiresTimedToolReconciliation } from './timedRecoveryFence'
import { dispatchTimedToolRegistrations, type TimedToolDispatchAdapter, type TimedToolDispatchResult } from './timedDispatchLoop'
import { ensureTimedDispatchEpoch } from './timedDispatchEpoch'

export { dispatchTimedToolRegistrations, type TimedToolDispatchAdapter, type TimedToolDispatchResult } from './timedDispatchLoop'

export interface TimedToolRegistration {
  name: string
  registrationVersion: number
  runtime: Tool['runtime']
}

export interface TimedToolDispatchRequest {
  sessionId: string
  timing: ToolCallTiming
  /** Persisted logical-model-request ordinal supplied by the outer loop when needed. */
  epoch?: number
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

function isFinalTiming(timing: ToolCallTiming): boolean {
  return timing === 'turnEnd' || timing === 'runEnd'
}

function isDispatchCurrent(base: ToolLoopBase, timing: ToolCallTiming): boolean {
  if (!base.control.isCurrent() || base.opts.signal.aborted) return false
  // A normal turn completes before its turnEnd/runEnd finally blocks. Those final
  // hooks may therefore run after `running` becomes `done`, but never after a
  // user stop or a recovery interruption.
  if (isFinalTiming(timing)) {
    const status = base.core.getSessionStore(base.id).store.getter(runAtom)?.status
    return status !== 'stopped' && status !== 'interrupted'
  }
  return base.control.isRunning()
}

function timedCallId(base: ToolLoopBase, request: TimedToolDispatchRequest, name: string): string {
  const { timing } = request
  if (timing === 'sessionStart') return `timed:${timing}:${name}`
  if (timing === 'runStart' || timing === 'runEnd') return `timed:${timing}:${base.runId}:${name}`
  const epoch = request.epoch ?? ensureTimedDispatchEpoch(base)
  return `timed:${timing}:${base.runId}:${epoch}:${name}`
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

function persistTimedItems(base: ToolLoopBase, checkpoints: ToolLoopCheckpointWriter, timing: ToolCallTiming): void {
  if (!isDispatchCurrent(base, timing)) return
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

/** Dispatches one timing bucket through the normal executor, never through beforeToolCall confirmation hooks. */
export async function dispatchTimedTools(input: {
  base: ToolLoopBase
  checkpoints: ToolLoopCheckpointWriter
  request: TimedToolDispatchRequest
}): Promise<TimedToolDispatchResult> {
  const { base, checkpoints, request } = input
  if (request.sessionId !== base.id || !isDispatchCurrent(base, request.timing)) {
    return { status: 'inactive', itemCount: 0 }
  }
  const registrations = base.core.timedToolRegistrations(request.timing)
  if (registrations.length === 0) return { status: 'dispatched', itemCount: 0 }
  const dependencies = await loadTimedDispatchDependencies()
  if (!isDispatchCurrent(base, request.timing)) return { status: 'inactive', itemCount: 0 }

  return dispatchTimedToolRegistrations({
    registrations,
    isCurrent: () => isDispatchCurrent(base, request.timing),
    createCallId: (name) => timedCallId(base, request, name),
    requiresReconciliation: (registration, callId) => requiresTimedToolReconciliation({
      base,
      request,
      name: registration.name,
      callId,
      isRecorded: (candidate) => timedItemAlreadyRecorded(base, candidate, dependencies),
    }),
    isRecorded: (callId) => timedItemAlreadyRecorded(base, callId, dependencies),
    beforeExecute: async (_registration, callId) => persistToolCallExecutionFence(base, [callId]),
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
      persistTimedItems(base, checkpoints, request.timing)
    },
    afterRecord: async () => requireRecoveryDurability(base.id, base.runId, base.core, 'timed_tool_result_saved'),
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
