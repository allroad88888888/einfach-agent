import {
  firstAssistantText,
  maxTurnToolsForVendor,
  type ModelChatResponse,
  type ModelFunctionTool,
  type ModelItem,
} from '@einfach-agent/ai'
import { buildTurnTools, narrowToolCalls } from '../runtime/modelTurn'
import {
  callSelectedSubagentModel,
  createSubagentModelSelection,
} from './modelSelection'
import { buildChildSystemPrompt, buildChildUserPrompt } from './prompt'
import { subagentAllowedTools } from './toolProfile'
import {
  executeChildAgentToolCalls,
  type ChildAgentToolLoopState,
} from './childAgentToolCalls'
import { appendVisibleChildTool, loadVisibleChildTool } from './childToolVisibility'
import {
  childExhaustionSummary,
  childMaxTurnsError,
  createChildRepetitionWatch,
} from './childLoopRepetition'
import type { ChildModelCaller } from './childModelClient'
import type { ChildContextCheckpoint } from './childContextCheckpoint'
import { createChildRolloutRecorder } from './childRolloutRecorder'
import { assertNormalChildFinish } from './childFinishReason'
import { createChildStartedArchivePayload } from './archiveEventPayload'
import { dispatchChildTimedTools, finalizeChildResult } from './childResult'
import type {
  ChildAgentResult,
  DelegateAgentCallContext,
  DelegateAgentChildSpec,
  SubagentNodeRecord,
  SubagentSkillFile,
  SubagentToolProfile,
} from './types'
import {
  type DelegationCallState,
  type DelegateAgents,
  DelegateAgentRuntimeState,
  isAbortError,
  toErrorMessage,
  type TreeRuntimeBudget,
} from './runtimeState'

const DEFAULT_CHILD_MAX_TURNS = 4
export interface RunChildAgentInput {
  runtime: DelegateAgentRuntimeState
  callModel: ChildModelCaller
  delegateAgents: DelegateAgents
  node: SubagentNodeRecord
  spec: DelegateAgentChildSpec
  context: DelegateAgentCallContext
  archiveBasePath: string
  inheritedSkills: SubagentSkillFile[]
  localSkill: SubagentSkillFile
  delegationState: DelegationCallState
  budget: TreeRuntimeBudget
  toolProfile: SubagentToolProfile
  confirmedTools: readonly string[]
}

function refreshChildVisibleTools(
  current: import('../tools/types').LoadedTool[],
  runtime: DelegateAgentRuntimeState,
  maxLoadedTools: number,
): import('../tools/types').LoadedTool[] {
  const visible = current.reduce<import('../tools/types').LoadedTool[]>((refreshed, snapshot) => {
    const latest = loadVisibleChildTool(snapshot.name, runtime)
    if (!latest) return refreshed
    return [...refreshed, latest.registrationVersion === snapshot.registrationVersion ? snapshot : latest]
  }, [])
  return maxLoadedTools > 0 ? visible.slice(-maxLoadedTools) : []
}

/** Runs the complete model and tool loop for one reserved child agent. */
export async function runChildAgent(input: RunChildAgentInput): Promise<ChildAgentResult> {
  const { runtime, callModel, delegateAgents, node, spec, context, archiveBasePath, inheritedSkills,
    localSkill, delegationState, budget, toolProfile, confirmedTools } = input
  const modelSelection = createSubagentModelSelection({
    primarySettings: runtime.opts.settings,
    parentPath: node.parentPath,
    spec,
    confirmedTools,
    tierRouting: runtime.tierRouting,
  })
  const maxTurnTools = maxTurnToolsForVendor(modelSelection.settings.vendor)
  const allowedToolNames = [...subagentAllowedTools(toolProfile), ...confirmedTools]
  const skillFiles = [...node.inheritedSkillFiles, localSkill.path]
  const skillIds = [...node.inheritedSkillIds, localSkill.skillId]
  const loop: ChildAgentToolLoopState = {
    messages: [
      {
        role: 'system',
        content: buildChildSystemPrompt({
          node,
          spec,
          inheritedSkills,
          localSkill,
          toolProfile,
          confirmedTools,
          customInstructions: runtime.opts.customInstructions,
          environment: runtime.opts.environment,
        }),
      },
      { role: 'user', content: buildChildUserPrompt(spec) },
    ],
    visible: [],
    recentToolNames: [],
    executedToolNames: [],
    changeSets: [],
  }
  loop.visible = allowedToolNames.reduce(
    (tools, name) => appendVisibleChildTool(tools, name, runtime, maxTurnTools - 1),
    loop.visible,
  )
  loop.recentToolNames = loop.visible.map((tool) => tool.name).reverse()
  const rolloutRecorder = createChildRolloutRecorder({
    driver: runtime.opts.core?.persistence.dependencies().agentRollout,
    conversationId: runtime.opts.sessionId,
    runId: runtime.opts.runId,
    agentPath: node.path,
  })
  let contextCheckpoint: ChildContextCheckpoint | undefined
  const maxTurns = spec.maxTurns ?? DEFAULT_CHILD_MAX_TURNS
  // 子 run 不装插件（没有 plugin host / hook 槽），故复用的是 loopGuard 的【判据】而非插件本身：
  // 只观测、不改控制流，撞上限时用它回答「它在重复什么」。
  const repetition = createChildRepetitionWatch()
  runtime.scheduler.markNode(runtime.opts.runId, node.path, 'running', {
    localSkillFiles: [localSkill.path],
    localSkillIds: [localSkill.skillId],
    inheritedSkillFiles: [...node.inheritedSkillFiles],
    inheritedSkillIds: [...node.inheritedSkillIds],
  })
  await runtime.archive.recordEvent(context, archiveBasePath, 'child_started', node.path, createChildStartedArchivePayload({
    objective: spec.objective,
    mode: spec.mode,
    modelTier: modelSelection.routeDecision.tier,
    model: modelSelection.settings.model,
    route_reason: modelSelection.routeDecision.reason,
    fallback_count: modelSelection.fallbackCount,
    requiresTemporalNormalization: spec.requiresTemporalNormalization,
    toolProfile,
    confirmedTools,
    skillId: localSkill.skillId,
    inheritedSkillIds: node.inheritedSkillIds,
  }))

  const dispatchChildTiming = (timing: 'subagentStart' | 'subagentEnd', turn: number): Promise<void> => (
    dispatchChildTimedTools({
      runtime, context, archiveBasePath, node, timing, turn, allowedToolNames,
      executedToolNames: loop.executedToolNames, changeSets: loop.changeSets,
    })
  )

  const canEscalateFlash = (): boolean => (
    confirmedTools.length === 0 && loop.changeSets.length === 0 && loop.executedToolNames.length === 0
  )
  const callRoutedChildModel = async (args: {
    messages: ModelItem[]
    tools: ModelFunctionTool[]
    toolChoice: 'auto' | 'none'
    turn: number
  }): Promise<ModelChatResponse> => callSelectedSubagentModel({
    selection: modelSelection,
    input: {
      primarySettings: runtime.opts.settings,
      parentPath: node.parentPath,
      spec,
      confirmedTools,
      tierRouting: runtime.tierRouting,
    },
    signal: runtime.opts.signal,
    invoke: (settings) => callModel(
      delegationState,
      {
        messages: args.messages,
        tools: args.tools,
        toolChoice: args.toolChoice,
        settings,
        contextCheckpoint,
        onContextCheckpoint: (nextCheckpoint) => { contextCheckpoint = nextCheckpoint },
        observe: {
          context,
          archiveBasePath,
          agentPath: node.path,
          turn: args.turn,
          phase: spec.mode === 'evaluator' ? 'evaluator' : 'subagent',
        },
      },
      budget.maxModelCalls,
    ),
    canEscalate: canEscalateFlash,
    onEscalated: async (escalation) => runtime.archive.bestEffortRecordEvent(
      context,
      archiveBasePath,
      'child_model_escalated',
      node.path,
      {
        fromModelTier: escalation.fromRoute.tier,
        toModelTier: escalation.toRoute.tier,
        fromModel: escalation.fromModel,
        toModel: escalation.toModel,
        route_reason: escalation.toRoute.reason,
        fallback_count: escalation.fallbackCount,
        trigger: escalation.trigger,
        ...(escalation.error === undefined ? {} : { error: escalation.error }),
      },
    ),
  })

  try {
    await rolloutRecorder.recordInitial(loop.messages)
    await dispatchChildTiming('subagentStart', 0)
    for (let turn = 0; turn < maxTurns; turn += 1) {
      const isSynthesisTurn = turn === maxTurns - 1
      const turnMessages = isSynthesisTurn
        ? [...loop.messages, {
            role: 'user' as const,
            content: spec.expectedOutput
              ? `工具调查到此结束。现在请仅输出最终结果，严格遵循：${spec.expectedOutput}`
              : '工具调查到此结束。现在请直接输出最终结论，不要再调用工具。',
          }]
        : loop.messages
      if (isSynthesisTurn) await rolloutRecorder.recordItem(turnMessages.at(-1)!)
      loop.visible = refreshChildVisibleTools(loop.visible, runtime, maxTurnTools - 1)
      const tools = isSynthesisTurn
        ? []
        : buildTurnTools(loop.visible, runtime.opts.hostHasLocalCapabilities === true, {
            allowedToolNames,
            registry: runtime.registry,
            vendor: modelSelection.settings.vendor,
            recentToolNames: loop.recentToolNames,
          })
      const requestedRegistrationVersions = new Map(
        allowedToolNames.map((name) => [name, runtime.registry.registrationVersion(name)] as const),
      )
      const response = await callRoutedChildModel({
        messages: turnMessages,
        tools,
        toolChoice: isSynthesisTurn ? 'none' : 'auto',
        turn: turn + 1,
      })
      const message = response.choices?.[0]?.message
      const toolCalls = narrowToolCalls(message?.tool_calls)
      const assistantItem: ModelItem = {
        role: 'assistant',
        content: typeof message?.content === 'string' ? message.content : null,
        reasoning_content: message?.reasoning_content ?? null,
        tool_calls: toolCalls,
      }
      await rolloutRecorder.recordItem(assistantItem)
      repetition.observeTurn(toolCalls)
      await runtime.archive.bestEffortRecordTraceItem(context, archiveBasePath, node.path, turn + 1, {
        role: 'assistant',
        content: typeof message?.content === 'string' ? message.content : null,
        reasoning_content: message?.reasoning_content ?? null,
        tool_calls: toolCalls,
      })
      await assertNormalChildFinish(response, archiveBasePath, node, runtime, context)
      if (toolCalls.length === 0) {
        const text = firstAssistantText(response) || '子 agent 未返回有效文本。'
        // 只有强制合成轮才是「撞 maxTurns 收尾」；提前收敛的轮次不该被追加打转说明。
        const summary = isSynthesisTurn ? childExhaustionSummary(text, repetition, maxTurns) : text
        await rolloutRecorder.recordSuccess()
        return finalizeChildResult({
          runtime, context, archiveBasePath, node, spec, status: 'done', summary, skillFiles, skillIds,
          changeSets: loop.changeSets, modelTier: modelSelection.routeDecision.tier,
          routeReason: modelSelection.routeDecision.reason, fallbackCount: modelSelection.fallbackCount,
        })
      }
      loop.messages.push(assistantItem)
      await executeChildAgentToolCalls({
        runtime, delegateAgents, loop, node, context, archiveBasePath, inheritedSkills, localSkill, skillFiles,
        skillIds, delegationState, budget, confirmedTools, allowedToolNames, maxTurnTools, turn: turn + 1,
        turnTools: tools, toolCalls, isSynthesisTurn, requestedRegistrationVersions,
        rolloutRecorder,
      })
    }
    throw childMaxTurnsError(repetition, maxTurns)
  } catch (error) {
    const message = toErrorMessage(error)
    const status = isAbortError(error, runtime.opts.signal) ? 'cancelled' : 'failed'
    await rolloutRecorder.settleFailure(status, message)
    return finalizeChildResult({
      runtime, context, archiveBasePath, node, spec, status, summary: message, skillFiles, skillIds,
      changeSets: loop.changeSets, modelTier: modelSelection.routeDecision.tier,
      routeReason: modelSelection.routeDecision.reason, fallbackCount: modelSelection.fallbackCount, error: message,
    })
  } finally {
    await dispatchChildTiming('subagentEnd', maxTurns + 1)
  }
}
