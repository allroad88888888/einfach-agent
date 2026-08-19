import type { ModelFunctionTool, ModelItem, ModelToolCall } from '@einfach-agent/ai'
import {
  parseToolCallArgs,
  searchToolManifestPage,
  touchRecentToolName,
} from '../runtime/modelTurn'
import { selectToolGate } from '../runtime/toolGates'
import { isDelegatableDangerousTool } from '../runtime/dangerousTools'
import { toolSchemaLoadedResult } from '../tools/schemaResult'
import { normalizeDelegateAgentInput } from './input'
import { agentPathDepth } from './path'
import { appendVisibleChildTool, loadVisibleChildTool } from './childToolVisibility'
import {
  isSubagentVerificationTool,
  isSubagentWorkspaceReadTool,
} from './toolProfile'
import type {
  DelegateAgentBatchResult,
  DelegateAgentCallContext,
  DelegateAgentInput,
  SubagentNodeRecord,
  SubagentSkillFile,
} from './types'
import {
  type ChildChangeSet,
  type DelegationCallState,
  type DelegateAgents,
  DelegateAgentRuntimeState,
  isAbortError,
  toErrorMessage,
} from './runtimeState'
import type { TreeRuntimeBudget } from './runtimeState'

const DELEGATE_TOOL_NAME = 'delegate_agent'
const ARGS_PREVIEW_LIMIT = 200

export interface ChildAgentToolLoopState {
  messages: ModelItem[]
  visible: import('../tools/types').LoadedTool[]
  recentToolNames: string[]
  executedToolNames: string[]
  changeSets: ChildChangeSet[]
}

export interface ExecuteChildAgentToolCallsInput {
  runtime: DelegateAgentRuntimeState
  delegateAgents: DelegateAgents
  loop: ChildAgentToolLoopState
  node: SubagentNodeRecord
  context: DelegateAgentCallContext
  archiveBasePath: string
  inheritedSkills: SubagentSkillFile[]
  localSkill: SubagentSkillFile
  skillFiles: string[]
  skillIds: string[]
  delegationState: DelegationCallState
  budget: TreeRuntimeBudget
  confirmedTools: readonly string[]
  allowedToolNames: readonly string[]
  maxTurnTools: number
  turn: number
  turnTools: ModelFunctionTool[]
  toolCalls: ModelToolCall[]
  isSynthesisTurn: boolean
  requestedRegistrationVersions: ReadonlyMap<string, number | undefined>
}

function argsPreviewForModel(raw: string): string {
  return raw.length > ARGS_PREVIEW_LIMIT ? `${raw.slice(0, ARGS_PREVIEW_LIMIT)}...` : raw
}

export async function executeChildAgentToolCalls(
  input: ExecuteChildAgentToolCallsInput,
): Promise<void> {
  const {
    runtime,
    delegateAgents,
    loop,
    node,
    context,
    archiveBasePath,
    inheritedSkills,
    localSkill,
    skillFiles,
    skillIds,
    delegationState,
    budget,
    confirmedTools,
    allowedToolNames,
    maxTurnTools,
    turn,
    turnTools,
    toolCalls,
    isSynthesisTurn,
    requestedRegistrationVersions,
  } = input
  const pushToolResult = async (toolCallId: string, content: string): Promise<void> => {
    const item: ModelItem = { role: 'tool', tool_call_id: toolCallId, content }
    loop.messages.push(item)
    await runtime.archive.bestEffortRecordTraceItem(
      context,
      archiveBasePath,
      node.path,
      turn,
      item,
    )
  }

  for (const toolCall of toolCalls) {
    const name = toolCall.function.name
    const parsedArgs = parseToolCallArgs(toolCall.function.arguments)
    if (!parsedArgs.ok) {
      await pushToolResult(
        toolCall.id,
        JSON.stringify({
          error: parsedArgs.error,
          hint: '请重新发起该工具调用，并确保 arguments 是完整合法的 JSON 对象',
          argumentsPreview: argsPreviewForModel(parsedArgs.raw),
        }),
      )
      continue
    }
    const callArgs = parsedArgs.args
    const expectedRegistrationVersion = requestedRegistrationVersions.get(name)
    const gate = selectToolGate({
      name,
      args: callArgs,
      turnTools,
      isSynthesisTurn,
      isAllowedTool: (toolName) => (
        allowedToolNames.includes(toolName) && loadVisibleChildTool(toolName, runtime) !== undefined
      ),
      loadSchema: (toolName) => loadVisibleChildTool(toolName, runtime),
      expectedRegistrationVersion,
      registrationVersion: (toolName) => runtime.registry.registrationVersion(toolName),
      canExecuteTool: (toolName) => loadVisibleChildTool(toolName, runtime) !== undefined && (
        isSubagentWorkspaceReadTool(toolName)
        || isDelegatableDangerousTool(toolName)
        || isSubagentVerificationTool(toolName)
      ),
      delegate: {
        name: DELEGATE_TOOL_NAME,
        path: node.path,
        depth: name === DELEGATE_TOOL_NAME ? agentPathDepth(node.path) : 0,
        maxDepth: budget.maxDepth,
      },
    })
    if (gate.kind === 'schema_request' || gate.kind === 'schema_request_denied') {
      const toolName = typeof callArgs.toolName === 'string' ? callArgs.toolName.trim() : ''
      await runtime.archive.recordEvent(context, archiveBasePath, 'child_tool_schema_requested', node.path, {
        toolName: toolName || undefined,
        discovery: !toolName,
      })
      if (gate.kind === 'schema_request_denied') {
        await pushToolResult(toolCall.id, JSON.stringify(gate.result))
        continue
      }
      if (toolName) {
        const loadedTool = loadVisibleChildTool(toolName, runtime)
        loop.visible = loadedTool
          ? appendVisibleChildTool(loop.visible, toolName, runtime, maxTurnTools - 1)
          : loop.visible
        if (loadedTool) {
          loop.recentToolNames = touchRecentToolName(
            loop.recentToolNames,
            toolName,
            maxTurnTools - 1,
          )
        }
        await pushToolResult(
          toolCall.id,
          JSON.stringify(loadedTool ? toolSchemaLoadedResult(loadedTool) : { error: 'unknown' }),
        )
        continue
      }
      await pushToolResult(
        toolCall.id,
        JSON.stringify(searchToolManifestPage(
          {
            query: typeof callArgs.query === 'string' ? callArgs.query : undefined,
            cursor: typeof callArgs.cursor === 'string' ? callArgs.cursor : undefined,
            limit: typeof callArgs.limit === 'number' ? callArgs.limit : undefined,
          },
          runtime.opts.hostHasLocalCapabilities === true,
          { registry: runtime.registry, allowedToolNames },
        )),
      )
      continue
    }
    if (gate.kind === 'schema_autoloaded') {
      if (gate.tool) {
        loop.visible = appendVisibleChildTool(loop.visible, name, runtime, maxTurnTools - 1)
        loop.recentToolNames = touchRecentToolName(loop.recentToolNames, name, maxTurnTools - 1)
        await runtime.archive.recordEvent(context, archiveBasePath, 'child_tool_schema_requested', node.path, {
          toolName: name,
          discovery: false,
          autoloaded: true,
        })
        await pushToolResult(toolCall.id, JSON.stringify(gate.result))
        continue
      }
    }
    if (gate.kind === 'registration_changed') {
      await pushToolResult(toolCall.id, JSON.stringify(gate.result))
      continue
    }
    if (gate.kind === 'delegate') {
      const normalized = normalizeDelegateAgentInput(callArgs)
      if (!normalized.ok) {
        await pushToolResult(toolCall.id, JSON.stringify({ error: normalized.error }))
        continue
      }
      await runtime.archive.recordEvent(context, archiveBasePath, 'nested_delegate_requested', node.path, {
        children: normalized.input.children.length,
        maxDepth: budget.maxDepth,
        maxChildren: budget.maxChildren,
      })
      loop.executedToolNames.push(name)
      let nested: DelegateAgentBatchResult | { error: string }
      try {
        const parentConfirmedTools = delegationState.confirmedToolsByPath.get(node.path) ?? []
        nested = await delegateAgents(callArgs as unknown as DelegateAgentInput, {
          ...context,
          parentPath: node.path,
          delegationCallId: toolCall.id,
          dangerousToolCapability: parentConfirmedTools.length > 0
            ? {
                sessionId: runtime.opts.sessionId,
                runId: runtime.opts.runId,
                delegationCallId: toolCall.id,
                parentPath: node.path,
                toolNames: parentConfirmedTools,
              }
            : undefined,
          parentTranscript: runtime.archiveFormat.formatParentTranscript(loop.messages),
          inheritedSkillFiles: skillFiles,
          inheritedSkillIds: skillIds,
          inheritedSkillContents: [...inheritedSkills, localSkill],
        })
      } catch (error) {
        if (isAbortError(error, runtime.opts.signal)) throw error
        nested = { error: toErrorMessage(error) }
      }
      await pushToolResult(toolCall.id, JSON.stringify(nested))
      runtime.observeChangeSets(nested, loop.changeSets)
      continue
    }
    if (gate.kind === 'execute') {
      if (!context.runChildTool) {
        await pushToolResult(toolCall.id, JSON.stringify({ error: `child tool unavailable: ${name}` }))
        continue
      }
      const startedAt = Date.now()
      let toolResult: Awaited<ReturnType<NonNullable<DelegateAgentCallContext['runChildTool']>>>
      try {
        toolResult = await context.runChildTool(name, callArgs, expectedRegistrationVersion)
      } catch (error) {
        if (isAbortError(error, runtime.opts.signal)) throw error
        toolResult = { ok: false, error: toErrorMessage(error) }
      }
      loop.executedToolNames.push(name)
      if (toolResult.ok) runtime.observeChangeSets(toolResult.data, loop.changeSets)
      await runtime.archive.bestEffortRecordEvent(context, archiveBasePath, 'child_tool_finished', node.path, {
        toolName: name,
        ok: toolResult.ok,
        durationMs: Date.now() - startedAt,
      })
      await pushToolResult(
        toolCall.id,
        JSON.stringify(
          toolResult.ok
            ? toolResult.warnings?.length
              ? { data: toolResult.data ?? { ok: true }, warnings: toolResult.warnings }
              : (toolResult.data ?? { ok: true })
            : {
                error: toolResult.error,
                ...(toolResult.code ? { code: toolResult.code } : {}),
                ...(toolResult.hint ? { hint: toolResult.hint } : {}),
                ...(toolResult.retryable !== undefined ? { retryable: toolResult.retryable } : {}),
                ...(toolResult.details !== undefined ? { details: toolResult.details } : {}),
              },
        ),
      )
      continue
    }
    await pushToolResult(toolCall.id, JSON.stringify(gate.result))
  }
}
