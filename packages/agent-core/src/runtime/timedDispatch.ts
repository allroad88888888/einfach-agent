import { isAbortError } from '@web-agent/ai'
import type { ToolCallTiming } from '../tools/toolCallTiming'
import type { Tool, ToolResult } from '../tools/types'
import type { ToolRegistry } from '../tools/toolRegistry'
import type { ToolLoopCheckpointWriter } from './toolLoopCheckpoint'
import type { ToolLoopBase } from './toolLoopContracts'
import { newId } from './newId'

export interface TimedToolRegistration {
  name: string
  registrationVersion: number
}

export interface TimedToolDispatchRequest {
  sessionId: string
  timing: ToolCallTiming
}

export interface TimedToolDispatchResult {
  status: 'dispatched' | 'no_active_run' | 'inactive'
  itemCount: number
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
        return registrationVersion === undefined || tools.callTiming(name) !== timing
          ? []
          : [{ name, registrationVersion }]
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

function riskForTimedCall(
  base: ToolLoopBase,
  name: string,
  dependencies: TimedDispatchDependencies,
) {
  const session = base.core.rootStore.getter(dependencies.sessionsAtom)[base.id]
  const workspaceRoot = dependencies.resolveSessionWorkspaceRoot(
    session,
    base.core.rootStore.getter(dependencies.workspacesAtom),
  )
  return dependencies.classifyToolRisk(name, {}, {
    workspaceRoot,
    mcpConnectTarget: base.core.config.mcpConnectTarget,
    mcpToolLaunchTarget: base.core.config.mcpToolLaunchTarget,
  })
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

  let itemCount = 0
  for (const { name, registrationVersion } of registrations) {
    if (!isDispatchCurrent(base)) return { status: 'inactive', itemCount }
    const callId = timedCallId(base, request.timing, name)
    if ((request.timing === 'sessionStart' || request.timing === 'runStart' || request.timing === 'runEnd') && timedItemAlreadyRecorded(base, callId, dependencies)) continue

    let result: ToolResult
    try {
      const risk = riskForTimedCall(base, name, dependencies)
      if (risk.level !== 'safe') {
        const error = `到点工具 ${name} 因风险等级 ${risk.level} 被拒绝执行`
        base.trace.event('tool.timed_rejected', {
          timing: request.timing,
          toolName: name,
          callId,
          risk: risk.level,
          reason: risk.reason,
        })
        result = { ok: false, error, details: { timing: request.timing, risk: risk.level } }
      } else {
        result = await dependencies.executeToolCall(base, { callId, name, args: {}, registrationVersion })
      }
    } catch (error) {
      if (isAbortError(error) || !isDispatchCurrent(base)) return { status: 'inactive', itemCount }
      const message = dependencies.safeErrorMessage(error)
      base.trace.event('tool.timed_failed', { timing: request.timing, toolName: name, callId, error: message })
      result = { ok: false, error: message }
    }
    if (!isDispatchCurrent(base)) return { status: 'inactive', itemCount }
    dependencies.appendMappedToolResult(base.id, callId, result, base.core)
    persistTimedItems(base, checkpoints)
    itemCount += 1
  }
  return { status: 'dispatched', itemCount }
}
