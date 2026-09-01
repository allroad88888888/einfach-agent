// runtime/toolContext/delegationCapabilities.ts —— 只在宿主注入 DelegationRuntime 时挂上的委派能力。
// 安全边界集中在 buildDelegateCallContext：
//   · 危险工具能力只从「本次 delegate_agent 入参 ∩ 可委派危险工具 ∩ 会话已永久放行」三重交集派生；
//   · runChildTool 是子 agent 的白名单闸门（只读工具 / 已确认危险工具 / workspace_verify 验证工具），
//     两侧 assertFresh，pause 一律拒绝；
//   · 归档写入走 subagentArchiveWriter（仍带 workspace confinement 与 ghost 守卫）。
// 全部逐字沿用拆分前 buildToolContext 尾部的 delegateRuntime 分支。

import type { ToolContext } from '../../tools/types'
import type {
  DelegateAgentCallContext,
  DelegateAgentInput,
  SubagentSkillFile,
} from '../../subagents/types'
import { getExecutionRuntime } from '../../execution/runtime'
import { ROOT_AGENT_PATH } from '../../subagents/path'
import {
  isSubagentHistoryTool,
  subagentProfileAllowsHistory,
} from '../../subagents/historyToolProfile'
import {
  isSubagentVerificationTool,
  isSubagentWorkspaceReadTool,
} from '../../subagents/toolProfile'
import { isToolAlwaysAllowed } from '../../state/transientAtoms'
import type { CoreInstance } from '../core/coreInstance'
import { isDelegatableDangerousTool } from '../dangerousTools'
import type { DelegationRuntime } from '../delegationContract'
import { createSubagentArchiveWriters } from './subagentArchiveWriter'
import type { ToolStaleGuards } from './staleGuards'
import type { WorkspaceInputGuards } from './workspaceInputGuards'

export interface DelegationCapabilityDeps {
  sessionId: string
  runId: string
  callId: string
  toolName: string
  toolArgs?: unknown
  agentPath?: string
  getParentTranscript?: () => string
  inheritedSkillFiles?: string[]
  inheritedSkillIds?: string[]
  inheritedSkillContents?: SubagentSkillFile[]
  delegateRuntime: DelegationRuntime
  core: CoreInstance
  guards: ToolStaleGuards
  progress: ToolContext['progress']
  inputGuards: Pick<WorkspaceInputGuards, 'withWorkspaceRoot'>
}

/** 就地在 ctx 上挂委派相关能力（ctx 本身也是子工具调用要用的 ToolContext）。 */
export function attachDelegationCapabilities(
  ctx: ToolContext,
  deps: DelegationCapabilityDeps,
): void {
  const { sessionId, runId, callId, core, delegateRuntime, progress } = deps
  const { assertFresh } = deps.guards
  const { writeSubagentTextFile, writeEvaluatorArchiveBestEffort } = createSubagentArchiveWriters({
    core,
    guards: deps.guards,
    progress,
    inputGuards: deps.inputGuards,
  })

  const buildDelegateCallContext = (input: DelegateAgentInput): DelegateAgentCallContext => {
    const requestedConfirmedTools = deps.toolName === 'delegate_agent'
      && deps.toolArgs && typeof deps.toolArgs === 'object' && !Array.isArray(deps.toolArgs)
      && Array.isArray((deps.toolArgs as Record<string, unknown>).confirmedTools)
      ? Array.from(new Set(
          ((deps.toolArgs as Record<string, unknown>).confirmedTools as unknown[])
            .filter((name): name is string =>
              typeof name === 'string' && isDelegatableDangerousTool(name))
            .filter((name) => isToolAlwaysAllowed(sessionId, name, core)),
        ))
      : []
    const dangerousToolCapability = requestedConfirmedTools.length > 0
      ? {
          sessionId,
          runId,
          delegationCallId: callId,
          parentPath: deps.agentPath ?? ROOT_AGENT_PATH,
          toolNames: requestedConfirmedTools,
        }
      : undefined
    const childToolCtx: ToolContext = ctx
    const callContext: DelegateAgentCallContext = {
      parentPath: deps.agentPath ?? ROOT_AGENT_PATH,
      delegationCallId: callId,
      parentTranscript: deps.getParentTranscript?.(),
      inheritedSkillFiles: deps.inheritedSkillFiles,
      inheritedSkillIds: deps.inheritedSkillIds,
      inheritedSkillContents: deps.inheritedSkillContents,
      dangerousToolCapability,
      progress,
      writeTextFile: deps.toolName === 'submit_stage_result'
        ? writeEvaluatorArchiveBestEffort
        : writeSubagentTextFile,
      async runChildTool(name, args, expectedRegistrationVersion) {
        assertFresh()
        const allowedReadOnlyTool = isSubagentWorkspaceReadTool(name)
          && (!isSubagentHistoryTool(name) || subagentProfileAllowsHistory(input.toolProfile))
        const confirmedDangerousTool = dangerousToolCapability?.toolNames.includes(name) === true
        const allowedVerificationTool = input.toolProfile === 'workspace_verify' && isSubagentVerificationTool(name)
        if (!allowedReadOnlyTool && !confirmedDangerousTool && !allowedVerificationTool) {
          return { ok: false, error: `tool not allowed for child agent: ${name}` }
        }
        const result = await core.tools.run(
          name,
          args,
          childToolCtx,
          expectedRegistrationVersion,
        )
        assertFresh()
        if ('pause' in result) return { ok: false, error: 'child tools cannot pause' }
        return result
      },
    }
    return callContext
  }

  // 只在 runtime 真的实现时才挂：否则 `typeof ctx.runLowCostExtraction === 'function'`
  // 恒真，工具那条「永久不可用」分支变成死代码，永久性失败会被报成可重试。
  if (delegateRuntime.runLowCostExtraction) {
    ctx.runLowCostExtraction = (input) => delegateRuntime.runLowCostExtraction!(input)
  }
  ctx.spawnAgents = (input, options) => {
    const callContext = buildDelegateCallContext(input)
    delegateRuntime.retain?.()
    return getExecutionRuntime(core).spawn({
      sessionId,
      runId,
      label: input.children.map((child) => child.objective).join('；'),
      task: async (executionSignal) => {
        const cancelDelegateRuntime = () => delegateRuntime.cancel?.()
        executionSignal.addEventListener('abort', cancelDelegateRuntime, { once: true })
        if (executionSignal.aborted) cancelDelegateRuntime()
        try {
          const result = await delegateRuntime.delegateAgents(input, callContext)
          return options?.onComplete ? await options.onComplete(result) : result
        } catch (error) {
          await options?.onError?.(error)
          throw error
        } finally {
          executionSignal.removeEventListener('abort', cancelDelegateRuntime)
          delegateRuntime.release?.()
        }
      },
    })
  }
  ctx.observeExecution = (executionId) =>
    getExecutionRuntime(core).observe(sessionId, executionId)
  ctx.joinExecution = (executionId, timeoutMs) =>
    getExecutionRuntime(core).join(sessionId, executionId, timeoutMs)
  ctx.cancelExecution = (executionId) =>
    getExecutionRuntime(core).cancel(sessionId, executionId)
}
