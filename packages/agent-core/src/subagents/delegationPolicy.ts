import { isDelegatableDangerousTool } from '../runtime/dangerousTools'
import { normalizeDelegateAgentInput } from './input'
import { ROOT_AGENT_PATH, agentPathDepth } from './path'
import {
  canNarrowSubagentToolProfile,
  DEFAULT_SUBAGENT_TOOL_PROFILE,
} from './toolProfile'
import type {
  DelegateAgentCallContext,
  DelegateAgentInput,
  SubagentToolProfile,
} from './types'
import {
  type DelegationCallState,
  DelegateAgentRuntimeState,
  type TreeRuntimeBudget,
} from './runtimeState'

export interface DelegationRequestPolicy {
  input: DelegateAgentInput
  parentPath: string
  isRootCall: boolean
  state: DelegationCallState
  budget: TreeRuntimeBudget
  requestedToolProfile: SubagentToolProfile
  requestedConfirmedTools: readonly string[]
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function isSubset(requested: readonly string[], ceiling: readonly string[]): boolean {
  return requested.every((name) => ceiling.includes(name))
}

/** Resolves inherited limits and capabilities for a single delegation request. */
export function resolveDelegationRequestPolicy(
  runtime: DelegateAgentRuntimeState,
  rawInput: DelegateAgentInput,
  context: DelegateAgentCallContext,
): DelegationRequestPolicy {
  const normalized = normalizeDelegateAgentInput(rawInput)
  if (!normalized.ok) throw new Error(normalized.error)
  const input = normalized.input
  const parentPath = context.parentPath || ROOT_AGENT_PATH
  const isRootCall = parentPath === ROOT_AGENT_PATH
  const state = isRootCall
    ? runtime.createDelegationCallState(input)
    : runtime.delegationStateByChildPath.get(parentPath)
  if (!state) throw new Error(`unknown subagent delegation parent path: ${parentPath}`)

  const inheritedBudget = state.budgetByPath.get(parentPath) ?? state.rootBudget
  const budget: TreeRuntimeBudget = {
    maxDepth: hasOwn(rawInput, 'maxDepth')
      ? Math.min(inheritedBudget.maxDepth, input.maxDepth ?? inheritedBudget.maxDepth)
      : inheritedBudget.maxDepth,
    maxChildren: hasOwn(rawInput, 'maxChildren')
      ? Math.min(inheritedBudget.maxChildren, input.maxChildren ?? inheritedBudget.maxChildren)
      : inheritedBudget.maxChildren,
    maxConcurrent: hasOwn(rawInput, 'maxConcurrent')
      ? Math.min(inheritedBudget.maxConcurrent, input.maxConcurrent ?? inheritedBudget.maxConcurrent)
      : inheritedBudget.maxConcurrent,
    maxTotalNodes: hasOwn(rawInput, 'maxTotalNodes')
      ? Math.min(inheritedBudget.maxTotalNodes, input.maxTotalNodes ?? inheritedBudget.maxTotalNodes)
      : inheritedBudget.maxTotalNodes,
    maxModelCalls: hasOwn(rawInput, 'maxModelCalls')
      ? Math.min(inheritedBudget.maxModelCalls, input.maxModelCalls ?? inheritedBudget.maxModelCalls)
      : inheritedBudget.maxModelCalls,
  }
  const inheritedToolProfile = isRootCall
    ? undefined
    : state.toolProfileByPath.get(parentPath) ?? DEFAULT_SUBAGENT_TOOL_PROFILE
  const requestedToolProfile = hasOwn(rawInput, 'toolProfile')
    ? input.toolProfile ?? DEFAULT_SUBAGENT_TOOL_PROFILE
    : inheritedToolProfile ?? DEFAULT_SUBAGENT_TOOL_PROFILE
  if (inheritedToolProfile && !canNarrowSubagentToolProfile(inheritedToolProfile, requestedToolProfile)) {
    throw new Error(
      `invalid delegate_agent: toolProfile ${requestedToolProfile} cannot widen inherited ${inheritedToolProfile}`,
    )
  }
  for (const child of input.children) {
    const childProfile = child.toolProfile ?? requestedToolProfile
    if (!canNarrowSubagentToolProfile(requestedToolProfile, childProfile)) {
      throw new Error(
        `invalid delegate_agent: child toolProfile ${childProfile} cannot widen inherited ${requestedToolProfile}`,
      )
    }
  }

  const pathConfirmedTools = state.confirmedToolsByPath.get(parentPath) ?? []
  const capability = context.dangerousToolCapability
  const capabilityIsScoped = capability
    && capability.sessionId === runtime.opts.sessionId
    && capability.runId === runtime.opts.runId
    && capability.parentPath === parentPath
    && typeof context.delegationCallId === 'string'
    && capability.delegationCallId === context.delegationCallId
    && capability.toolNames.every(isDelegatableDangerousTool)
    && (parentPath === ROOT_AGENT_PATH || isSubset(capability.toolNames, pathConfirmedTools))
  const inheritedConfirmedTools = capabilityIsScoped ? Array.from(new Set(capability.toolNames)) : []
  const requestedConfirmedTools = hasOwn(rawInput, 'confirmedTools') ? (input.confirmedTools ?? []) : []
  if (!isSubset(requestedConfirmedTools, inheritedConfirmedTools)) {
    throw new Error('invalid delegate_agent: confirmedTools cannot exceed the verified parent capability')
  }
  for (const child of input.children) {
    const childTools = child.confirmedTools ?? requestedConfirmedTools
    if (!isSubset(childTools, requestedConfirmedTools)) {
      throw new Error('invalid delegate_agent: child confirmedTools cannot widen the batch capability')
    }
  }
  if (agentPathDepth(parentPath) >= budget.maxDepth) {
    throw new Error(`max subagent depth reached at ${parentPath}`)
  }
  if (input.children.length > budget.maxChildren) {
    throw new Error(
      `invalid delegate_agent: children length ${input.children.length} exceeds inherited maxChildren ${budget.maxChildren}`,
    )
  }
  return {
    input,
    parentPath,
    isRootCall,
    state,
    budget,
    requestedToolProfile,
    requestedConfirmedTools,
  }
}
