import { createConcurrencyLimiter } from '@web-agent/core/runtime/concurrencyLimiter'
import { resolveDelegationRequestPolicy } from '@web-agent/core/subagents/delegationPolicy'
import { runChildAgent } from '@web-agent/core/subagents/childAgentLoop'
import { createChildModelCaller } from '@web-agent/core/subagents/childModelClient'
import {
  ROOT_AGENT_PATH,
  routeChildModel,
  type ChildAgentResult,
  type DelegateAgentBatchResult,
  type DelegateAgentBatchStatus,
  type DelegateAgentCallContext,
  type DelegateAgentInput,
  type DelegateAgents,
  type SubagentNodeRecord,
} from '@web-agent/core/subagents'
import { subagentCacheBasePath, subagentEventsPath } from './archive/skillCache'
import { distillDelegateSkills } from './archive/distill'
import {
  collectChangeSets,
  DelegateAgentRuntimeState,
  isAbortError,
  toErrorMessage,
  type ChildChangeSet,
  type DelegationCallState,
} from '@web-agent/core/subagents/runtimeState'
import { createSkillDistillChat } from './delegationDistillation'

function childSummary(children: readonly ChildAgentResult[]): DelegateAgentBatchResult['summary'] {
  return {
    total: children.length,
    done: children.filter((child) => child.status === 'done').length,
    failed: children.filter((child) => child.status === 'failed').length,
    cancelled: children.filter((child) => child.status === 'cancelled').length,
  }
}

function batchStatus(
  strategy: DelegateAgentInput['strategy'],
  summary: DelegateAgentBatchResult['summary'],
): DelegateAgentBatchStatus {
  if (summary.cancelled > 0) return 'cancelled'
  if (summary.failed === 0) return 'done'
  if (strategy === 'parallel_best_effort' && summary.done > 0) return 'partial'
  return 'failed'
}

/** Reserves a child batch, distills its briefs, runs it, and aggregates its result. */
export function createDelegateAgents(runtime: DelegateAgentRuntimeState): DelegateAgents {
  const callModel = createChildModelCaller(runtime)
  const distillChat = createSkillDistillChat(callModel)
  const delegateAgents: DelegateAgents = async (rawInput, context) => {
    const policy = resolveDelegationRequestPolicy(runtime, rawInput, context)
    const {
      input, parentPath, isRootCall, state, budget, requestedToolProfile, requestedConfirmedTools,
    } = policy
    const archiveBasePath = subagentCacheBasePath(runtime.opts.sessionId, runtime.opts.runId)
    await runtime.archive.ensureArchiveInitialized(context, archiveBasePath)
    runtime.scheduler.markNode(runtime.opts.runId, parentPath, 'running')
    await runtime.archive.recordEvent(context, archiveBasePath, 'delegate_requested', parentPath, {
      children: input.children.map((child) => {
        const confirmedTools = child.confirmedTools ?? requestedConfirmedTools
        const route = routeChildModel({
          primarySettings: runtime.opts.settings,
          parentPath,
          spec: child,
          confirmedTools,
          tierRouting: runtime.tierRouting,
        })
        return {
          objective: child.objective,
          mode: child.mode,
          expectedOutput: child.expectedOutput,
          modelTier: route.tier,
          route_reason: route.reason,
          requiresTemporalNormalization: child.requiresTemporalNormalization,
          toolProfile: child.toolProfile ?? requestedToolProfile,
          confirmedTools,
        }
      }),
      strategy: input.strategy ?? 'parallel_wait_all',
      maxDepth: budget.maxDepth,
      maxChildren: budget.maxChildren,
      maxConcurrent: budget.maxConcurrent,
      maxTotalNodes: budget.maxTotalNodes,
      maxModelCalls: budget.maxModelCalls,
      totalNodesUsed: state.totalNodesUsed,
      modelCallsUsed: state.modelCallsUsed,
      toolProfile: requestedToolProfile,
      confirmedTools: requestedConfirmedTools,
    })
    context.progress(`启动 ${input.children.length} 个子 agent: ${parentPath}`)
    const inheritedSkillFiles = context.inheritedSkillFiles ?? []
    const inheritedSkillIds = context.inheritedSkillIds ?? context.inheritedSkillContents?.map((skill) => skill.skillId) ?? []
    const inheritedSkillContents = context.inheritedSkillContents ?? []
    try {
      runtime.reserveNodes(state, input.children.length, budget.maxTotalNodes)
    } catch (error) {
      await recordReservationFailure(runtime, context, archiveBasePath, parentPath, isRootCall, state, error)
      throw error
    }
    let reserved
    try {
      reserved = runtime.scheduler.reserveChildren({
        treeId: runtime.opts.runId,
        sessionId: runtime.opts.sessionId,
        delegationCallId: context.delegationCallId,
        parentPath,
        inheritedSkillFiles,
        inheritedSkillIds,
        children: input.children,
      })
    } catch (error) {
      state.totalNodesUsed -= input.children.length
      throw error
    }
    reserved.forEach((node, index) => {
      const spec = input.children[index]
      state.budgetByPath.set(node.path, {
        maxDepth: Math.min(budget.maxDepth, spec.maxDepth ?? budget.maxDepth),
        maxChildren: Math.min(budget.maxChildren, spec.maxChildren ?? budget.maxChildren),
        maxConcurrent: budget.maxConcurrent,
        maxTotalNodes: budget.maxTotalNodes,
        maxModelCalls: budget.maxModelCalls,
      })
      state.toolProfileByPath.set(node.path, spec.toolProfile ?? requestedToolProfile)
      state.confirmedToolsByPath.set(node.path, spec.confirmedTools ?? requestedConfirmedTools)
      runtime.delegationStateByChildPath.set(node.path, state)
    })
    const parent = runtime.scheduler.snapshot(runtime.opts.runId).find((node) => node.path === parentPath)
    const parentDispatchIndex = parent ? Math.max(1, parent.dispatchCounter) : 1
    await runtime.archive.recordEvent(context, archiveBasePath, 'children_reserved', parentPath, {
      paths: reserved.map((node) => node.path),
      dispatchCounter: parentDispatchIndex,
      totalNodesUsed: state.totalNodesUsed,
      maxTotalNodes: state.rootBudget.maxTotalNodes,
    })
    reserved.forEach((node) => runtime.scheduler.markNode(runtime.opts.runId, node.path, 'distilling'))
    const distilled = await distillBatchSkills(
      runtime, distillChat, context, archiveBasePath, parentPath, parentDispatchIndex,
      input, state, budget.maxModelCalls, inheritedSkillFiles, inheritedSkillIds, context.parentTranscript ?? '', reserved,
    )
    const allDistilledFiles = [distilled.coreSkill, ...distilled.childSkills]
    await Promise.all(allDistilledFiles.map((skill) => runtime.archive.persistSkill(context, archiveBasePath, skill)))
    const parentBefore = runtime.scheduler.snapshot(runtime.opts.runId).find((node) => node.path === parentPath)
    runtime.scheduler.markNode(runtime.opts.runId, parentPath, 'running', {
      localSkillFiles: Array.from(new Set([...(parentBefore?.localSkillFiles ?? []), distilled.coreSkill.path])),
      localSkillIds: Array.from(new Set([...(parentBefore?.localSkillIds ?? []), distilled.coreSkill.skillId])),
      inheritedSkillFiles,
      inheritedSkillIds,
    })
    const children = await createConcurrencyLimiter(budget.maxConcurrent).runAll(reserved.map((node, index) => () =>
      runChildAgent({
        runtime, callModel, delegateAgents,
        node: { ...node, inheritedSkillFiles: [...inheritedSkillFiles, distilled.coreSkill.path], inheritedSkillIds: [...inheritedSkillIds, distilled.coreSkill.skillId] },
        spec: input.children[index], context, archiveBasePath,
        inheritedSkills: [...inheritedSkillContents, distilled.coreSkill], localSkill: distilled.childSkills[index],
        delegationState: state, budget: state.budgetByPath.get(node.path) ?? budget,
        toolProfile: state.toolProfileByPath.get(node.path) ?? requestedToolProfile,
        confirmedTools: state.confirmedToolsByPath.get(node.path) ?? [],
      }),
    ))
    const changeSets: ChildChangeSet[] = []
    children.forEach((child) => collectChangeSets({ changeSets: child.changeSets ?? [] }, changeSets))
    changeSets.sort((left, right) => (runtime.changeSetOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (runtime.changeSetOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER))
    const summary = childSummary(children)
    const status = batchStatus(input.strategy, summary)
    if (isRootCall) runtime.scheduler.markNode(runtime.opts.runId, parentPath, status === 'partial' ? 'done' : status)
    await runtime.archive.persistTreeSnapshot(context, archiveBasePath, runtime.scheduler.snapshot(runtime.opts.runId))
    await runtime.archive.writeRunArchiveRecord(context, archiveBasePath, 'delegated', isRootCall)
    await runtime.archive.recordEvent(context, archiveBasePath, 'delegate_finished', parentPath, {
      status, summary, children: children.map((child) => ({ path: child.path, status: child.status })),
      skillIds: allDistilledFiles.map((skill) => skill.skillId), budgetUsage: runtime.budgetUsage(state),
    })
    return {
      treeId: runtime.opts.runId, conversationId: runtime.opts.sessionId, runId: runtime.opts.runId,
      parentPath, strategy: input.strategy ?? 'parallel_wait_all', status, summary,
      cacheBasePath: archiveBasePath, archiveBasePath, eventLog: subagentEventsPath(archiveBasePath),
      skillFiles: allDistilledFiles.map((skill) => skill.path), skillIds: allDistilledFiles.map((skill) => skill.skillId),
      budgetUsage: runtime.budgetUsage(state), changeSets, reversible: changeSets.every((changeSet) => changeSet.reversible), children,
    }
  }
  return delegateAgents
}

async function recordReservationFailure(
  runtime: DelegateAgentRuntimeState,
  context: DelegateAgentCallContext,
  archiveBasePath: string,
  parentPath: string,
  isRootCall: boolean,
  state: DelegationCallState,
  error: unknown,
): Promise<void> {
  const message = toErrorMessage(error)
  if (isRootCall) runtime.scheduler.markNode(runtime.opts.runId, parentPath, 'failed', { error: message })
  await runtime.archive.bestEffortRecordEvent(context, archiveBasePath, 'delegate_finished', parentPath, {
    status: 'failed', children: [], error: message, budgetUsage: runtime.budgetUsage(state),
  })
  try {
    await runtime.archive.writeRunArchiveRecord(context, archiveBasePath, 'delegated', isRootCall)
  } catch {
    // Preserve the budget error as the primary failure.
  }
}

async function distillBatchSkills(
  runtime: DelegateAgentRuntimeState,
  distillChat: ReturnType<typeof createSkillDistillChat>,
  context: DelegateAgentCallContext,
  archiveBasePath: string,
  parentPath: string,
  parentDispatchIndex: number,
  input: DelegateAgentInput,
  state: DelegationCallState,
  maxModelCalls: number,
  inheritedSkillFiles: string[],
  inheritedSkillIds: string[],
  parentTranscript: string,
  reserved: SubagentNodeRecord[],
) {
  try {
    return await distillDelegateSkills({
      conversationId: runtime.opts.sessionId, runId: runtime.opts.runId, cacheBasePath: archiveBasePath,
      parentPath, parentDispatchIndex, strategy: input.strategy ?? 'parallel_wait_all', parentTranscript,
      inheritedSkillFiles, inheritedSkillIds,
      children: reserved.map((node, index) => ({ node, spec: input.children[index] })),
      chat: (request) => distillChat(state, request, maxModelCalls, {
        context, archiveBasePath, agentPath: parentPath, turn: 0, phase: 'distill:core',
      }),
    })
  } catch (error) {
    const message = toErrorMessage(error)
    const status = isAbortError(error, runtime.opts.signal) ? 'cancelled' : 'failed'
    const children: ChildAgentResult[] = reserved.map((node, index) => {
      runtime.scheduler.markNode(runtime.opts.runId, node.path, status, { error: message })
      return {
        path: node.path, status, objective: input.children[index].objective, summary: message,
        skillFiles: [...node.inheritedSkillFiles], skillIds: [...node.inheritedSkillIds], changeSets: [], error: message,
      }
    })
    if (parentPath === ROOT_AGENT_PATH) {
      runtime.scheduler.markNode(runtime.opts.runId, parentPath, status, { error: message })
    }
    await Promise.all(children.map((child) => runtime.archive.bestEffortRecordEvent(
      context, archiveBasePath, 'child_finished', child.path,
      { status: child.status, objective: child.objective, summary: child.summary, skillFiles: child.skillFiles, skillIds: child.skillIds, error: child.error },
    )))
    try {
      await runtime.archive.persistTreeSnapshot(context, archiveBasePath, runtime.scheduler.snapshot(runtime.opts.runId))
      await runtime.archive.writeRunArchiveRecord(context, archiveBasePath, 'delegated', parentPath === ROOT_AGENT_PATH)
    } catch {
      // Keep the distillation/abort error as the primary failure.
    }
    await runtime.archive.bestEffortRecordEvent(context, archiveBasePath, 'delegate_finished', parentPath, {
      status, children: children.map((child) => ({ path: child.path, status: child.status })), error: message,
      budgetUsage: runtime.budgetUsage(state),
    })
    throw error
  }
}
