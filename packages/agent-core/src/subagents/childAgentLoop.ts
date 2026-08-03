import {
  maxTurnToolsForVendor,
  type ModelChatResponse,
  type ModelFunctionTool,
  type ModelItem,
} from '@web-agent/ai'
import { buildTurnTools, narrowToolCalls } from '../runtime/modelTurn'
import {
  FINISH_REASON_ERRORS,
  isAbnormalFinishReason,
} from '../runtime/core/plugins/finishReasonPlugin'
import { subagentResultPath } from './skillCache'
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
import { firstAssistantText, type ChildModelCaller } from './childModelClient'
import type { DelegateAgents } from './delegationBatch'
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
  DelegateAgentRuntimeState,
  isAbortError,
  toErrorMessage,
  type TreeRuntimeBudget,
} from './runtimeState'

const DEFAULT_CHILD_MAX_TURNS = 4
const TRUNCATED_TEXT_PREVIEW_LIMIT = 200

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

function truncatedTextPreview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  return flat.length > TRUNCATED_TEXT_PREVIEW_LIMIT
    ? `${flat.slice(0, TRUNCATED_TEXT_PREVIEW_LIMIT)}...`
    : flat
}

async function throwForAbnormalFinish(
  response: ModelChatResponse,
  archiveBasePath: string,
  node: SubagentNodeRecord,
  runtime: DelegateAgentRuntimeState,
  context: DelegateAgentCallContext,
): Promise<void> {
  const finishReason = response.choices?.[0]?.finish_reason ?? null
  const toolCalls = narrowToolCalls(response.choices?.[0]?.message?.tool_calls)
  if (finishReason === 'length' && toolCalls.length > 0) return
  if (!isAbnormalFinishReason(finishReason)) return
  const fullText = finishReason === 'length' ? firstAssistantText(response) : ''
  let partialPath = ''
  if (fullText) {
    const candidate = subagentResultPath(archiveBasePath, node.path).replace(/\.md$/, '.partial.md')
    try {
      await runtime.archive.writeText(context, candidate, `${fullText.trim()}\n`)
      partialPath = candidate
    } catch {
      partialPath = ''
    }
  }
  const preview = truncatedTextPreview(fullText)
  const detail = [
    preview ? `截断片段（仅供定位，不完整）: ${preview}` : '',
    partialPath ? `完整残稿已存至 ${partialPath}（未经校验，采信前请自行判断）` : '',
  ].filter(Boolean).join('；')
  throw new Error(
    detail ? `${FINISH_REASON_ERRORS[finishReason]}；${detail}` : FINISH_REASON_ERRORS[finishReason],
  )
}

/** Runs the complete model and tool loop for one reserved child agent. */
export async function runChildAgent(input: RunChildAgentInput): Promise<ChildAgentResult> {
  const {
    runtime,
    callModel,
    delegateAgents,
    node,
    spec,
    context,
    archiveBasePath,
    inheritedSkills,
    localSkill,
    delegationState,
    budget,
    toolProfile,
    confirmedTools,
  } = input
  const modelSelection = createSubagentModelSelection({
    primarySettings: runtime.opts.settings,
    parentPath: node.parentPath,
    spec,
    confirmedTools,
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
  const maxTurns = spec.maxTurns ?? DEFAULT_CHILD_MAX_TURNS
  runtime.scheduler.markNode(runtime.opts.runId, node.path, 'running', {
    localSkillFiles: [localSkill.path],
    localSkillIds: [localSkill.skillId],
    inheritedSkillFiles: [...node.inheritedSkillFiles],
    inheritedSkillIds: [...node.inheritedSkillIds],
  })
  await runtime.archive.recordEvent(context, archiveBasePath, 'child_started', node.path, {
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
  })

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
    },
    signal: runtime.opts.signal,
    invoke: (settings) => callModel(
      delegationState,
      {
        messages: args.messages,
        tools: args.tools,
        toolChoice: args.toolChoice,
        settings,
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
      loop.visible = refreshChildVisibleTools(loop.visible, runtime, maxTurnTools - 1)
      const tools = isSynthesisTurn
        ? []
        : buildTurnTools(loop.visible, runtime.opts.runtimeIsTauri === true, {
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
      await runtime.archive.bestEffortRecordTraceItem(context, archiveBasePath, node.path, turn + 1, {
        role: 'assistant',
        content: typeof message?.content === 'string' ? message.content : null,
        reasoning_content: message?.reasoning_content ?? null,
        tool_calls: toolCalls,
      })
      await throwForAbnormalFinish(response, archiveBasePath, node, runtime, context)
      if (toolCalls.length === 0) {
        const summary = firstAssistantText(response) || '子 agent 未返回有效文本。'
        const resultPath = subagentResultPath(archiveBasePath, node.path)
        await runtime.archive.writeText(context, resultPath, `${summary.trim()}\n`)
        runtime.scheduler.markNode(runtime.opts.runId, node.path, 'done', {
          resultFile: resultPath,
          localSkillFiles: [localSkill.path],
          localSkillIds: [localSkill.skillId],
          inheritedSkillFiles: [...node.inheritedSkillFiles],
          inheritedSkillIds: [...node.inheritedSkillIds],
        })
        await runtime.archive.recordEvent(context, archiveBasePath, 'child_finished', node.path, {
          status: 'done', objective: spec.objective, summary, resultFile: resultPath, skillFiles, skillIds,
          modelTier: modelSelection.routeDecision.tier,
          route_reason: modelSelection.routeDecision.reason,
          fallback_count: modelSelection.fallbackCount,
        })
        return childResult('done', node.path, spec.objective, summary, skillFiles, skillIds, loop.changeSets, {
          resultFile: resultPath,
          modelTier: modelSelection.routeDecision.tier,
          routeReason: modelSelection.routeDecision.reason,
          fallbackCount: modelSelection.fallbackCount,
        })
      }
      loop.messages.push({
        role: 'assistant',
        content: typeof message?.content === 'string' ? message.content : null,
        reasoning_content: message?.reasoning_content ?? null,
        tool_calls: toolCalls,
      })
      await executeChildAgentToolCalls({
        runtime, delegateAgents, loop, node, context, archiveBasePath, inheritedSkills, localSkill, skillFiles,
        skillIds, delegationState, budget, confirmedTools, allowedToolNames, maxTurnTools, turn: turn + 1,
        turnTools: tools, toolCalls, isSynthesisTurn, requestedRegistrationVersions,
      })
    }
    throw new Error(`child agent exceeded maxTurns ${maxTurns}`)
  } catch (error) {
    const message = toErrorMessage(error)
    const status = isAbortError(error, runtime.opts.signal) ? 'cancelled' : 'failed'
    runtime.scheduler.markNode(runtime.opts.runId, node.path, status, {
      error: message,
      localSkillFiles: [localSkill.path], localSkillIds: [localSkill.skillId],
      inheritedSkillFiles: [...node.inheritedSkillFiles], inheritedSkillIds: [...node.inheritedSkillIds],
    })
    await runtime.archive.bestEffortRecordEvent(context, archiveBasePath, 'child_finished', node.path, {
      status, objective: spec.objective, summary: message, error: message, skillFiles, skillIds,
      modelTier: modelSelection.routeDecision.tier,
      route_reason: modelSelection.routeDecision.reason,
      fallback_count: modelSelection.fallbackCount,
    })
    return childResult(status, node.path, spec.objective, message, skillFiles, skillIds, loop.changeSets, {
      modelTier: modelSelection.routeDecision.tier,
      routeReason: modelSelection.routeDecision.reason,
      fallbackCount: modelSelection.fallbackCount,
      error: message,
    })
  }
}

function childResult(
  status: ChildAgentResult['status'],
  path: string,
  objective: string,
  summary: string,
  skillFiles: string[],
  skillIds: string[],
  changeSets: ChildAgentResult['changeSets'],
  extra: Omit<ChildAgentResult, 'path' | 'status' | 'objective' | 'summary' | 'skillFiles' | 'skillIds' | 'changeSets'>,
): ChildAgentResult {
  return { path, status, objective, summary, skillFiles, skillIds, changeSets, ...extra }
}
