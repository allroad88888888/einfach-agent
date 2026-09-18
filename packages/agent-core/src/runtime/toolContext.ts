// runtime/toolContext.ts —— 构造工具的副作用白名单 ctx（TOOLS-SPEC §4/§5/§8）。
// ---------------------------------------------------------------------------
// 这是「工具能做的事」的唯一实现方 + 守卫方（取代旧 toolExecution.ts 的内联副作用）：
//   · progress   —— 写会话 store 的瞬态 toolActivityAtom（含 isCurrent/signal 守卫）。
//   · renderCard —— addBrowserCard + stale 守卫，回 {cardId}/{error:'stale'}。
//   · saveArtifact —— addPendingArtifact + stale 守卫，回 {artifactId}/{error:'stale'}。
//   · callTool  —— 经工厂 run 转发，防环 + 限深 + signal 透传；pause 不许经 callTool 冒泡（§8）。
// 工具本身绝不 import atom/store —— 一切副作用都经这里。stale 守卫（ghost + 迟到 run）集中在此，
// 不再由每个工具各写一遍。
//
// 本文件只剩「出口 + 装配」：能力按职责落在 toolContext/ 下，各自带自己的守卫说明——
//   · staleGuards           —— assertFresh / assertArchiveCurrent。
//   · progressReporting     —— progress 与三种进度文案。
//   · workspaceInputGuards  —— workspaceRoot 注入、跨 workspace 只读权限、变更上下文、shell cwd。
//   · workspaceCapabilities —— shell / 文件 / Git / 任务副作用。
//   · outputCapabilities    —— renderCard / saveArtifact。
//   · planCapabilities、skillsCapabilities、subagentArchiveWriter、delegationCapabilities。
// callTool 的防环/限深留在本文件：它就是这层装配本身（递归再建一个 ctx）。
//
// 【实例化 · 第 2 期穿线】buildToolContext 末尾加了可选 core（CoreInstance，默认 defaultCore）：
//   ctx 里所有对 store/registry 的读写一律经这个 core —— isCurrentRun / resolveWorkspaceRoot 读
//   core.rootStore，进度/卡片/产物写 core.getSessionStore(id).store（经 writers 的新 core 尾参），
//   callTool 经 core.tools.run 且把 core 递归传给子 ctx。默认 defaultCore＝穿线前的模块全局单例，
//   故不传 core 的调用点（含全部现有测试）行为逐字不变。
//   子 agent 委派路径也沿用当前 core：manifest/schema 由 delegate runtime 的同一 registry 生成，
//   runChildTool 再通过 core.tools 原子校验 schema 快照版本并执行。

import type { ToolContext, ToolResult } from '../tools/types'
import type { ContextCompactionCapability } from '../tools/contextCompaction'
import type { ToolCatalog } from '../tools/toolCatalog'
import type { SubagentSkillFile } from '../subagents/types'
import { sessionsAtom } from '../state/rootStore'
import { defaultCore, type CoreInstance } from './core/coreInstance'
import type { DelegationRuntime } from './delegationContract'
import { attachDelegationCapabilities } from './toolContext/delegationCapabilities'
import { createOutputCapabilities } from './toolContext/outputCapabilities'
import { createPlanCapabilities } from './toolContext/planCapabilities'
import { createProgressReporter } from './toolContext/progressReporting'
import {
  createSkillsCapabilities,
  type RunSkillSnapshot,
} from './toolContext/skillsCapabilities'
import { createStaleGuards } from './toolContext/staleGuards'
import { createWorkspaceCapabilities } from './toolContext/workspaceCapabilities'
import { createVisionCapabilities } from './toolContext/visionCapabilities'
import { createHistoryCapabilities } from './toolContext/historyCapabilities'
import {
  createWorkspaceInputGuards,
  resolveWorkspaceRoot,
} from './toolContext/workspaceInputGuards'
import {
  capabilityToolCatalog,
  captureRunCapabilitySnapshot,
  runToolUnavailableResult,
  sessionToolCapabilityDeniedResult,
  type RunCapabilitySnapshot,
} from './turnToolVisibility'
import { hasHostBridge } from './hostBridge'

const MAX_TOOL_DEPTH = 4

/**
 * 为一次工具调用构造 ctx。callId = 该 tool_call 的 id（进度按它归属）；stack = 当前互调链上的工具名
 * （防环/限深用，顶层为空）。
 */
export function buildToolContext(opts: {
  sessionId: string
  runId: string
  signal: AbortSignal
  callId: string
  toolName: string
  toolArgs?: unknown
  contextCompaction?: ContextCompactionCapability
  stack?: readonly string[]
  agentPath?: string
  getParentTranscript?: () => string
  inheritedSkillFiles?: string[]
  inheritedSkillIds?: string[]
  inheritedSkillContents?: SubagentSkillFile[]
  delegateRuntime?: DelegationRuntime
  capabilitySnapshot?: RunCapabilitySnapshot
  skillSnapshot?: RunSkillSnapshot
  toolCatalog?: ToolCatalog
  hostHasLocalCapabilities?: boolean
  // 【实例化第 2 期】core 决定这次工具调用读写哪套 store/registry/abort；默认 defaultCore（＝穿线前
  //   的模块全局单例），故不传 core 的调用点（含全部现有测试）行为逐字不变。callTool 递归时把本次
  //   core 原样传给子 ctx，保证整条同 agent 互调链落在同一实例。
  core?: CoreInstance
}): ToolContext {
  const { sessionId, runId, signal, callId } = opts
  const stack = opts.stack ?? []
  const core = opts.core ?? defaultCore
  const session = core.rootStore.getter(sessionsAtom)[sessionId]
  const capabilitySnapshot = opts.capabilitySnapshot
    ?? captureRunCapabilitySnapshot(session?.capabilityPolicy)
  const runToolCatalog = opts.toolCatalog
    ?? capabilityToolCatalog(core.tools.snapshot(), capabilitySnapshot)
  const enforceHostCapabilities = opts.hostHasLocalCapabilities !== undefined
  const hostHasLocalCapabilities = opts.hostHasLocalCapabilities ?? hasHostBridge()
  const currentRunGuard = {
    root: core.rootStore,
    getStore: () => core.getSessionStore(sessionId).store,
    sessionId,
    runId,
  }

  // S4-A：本会话 workspace root（ctx 构造期解析一次；一次 run 内稳定）。
  const workspaceRoot = resolveWorkspaceRoot(sessionId, core)
  // Auto 的跨 workspace 只读权限只从宿主会话状态派生。它不会进入工具 schema，且
  // withWorkspaceReadAccess 会覆盖/移除调用方同名字段，避免模型伪造 runtime-only 权限。
  const allowExternalReadPaths =
    session?.toolApprovalMode === 'auto'

  const guards = createStaleGuards({ signal, currentRun: currentRunGuard })
  const progress = createProgressReporter({
    sessionId,
    callId,
    toolName: opts.toolName,
    signal,
    currentRun: currentRunGuard,
    core,
  })
  const inputGuards = createWorkspaceInputGuards({
    sessionId,
    runId,
    callId,
    workspaceRoot,
    allowExternalReadPaths,
  })
  const planCapabilities = createPlanCapabilities({ sessionId, core, guards })
  const skillsCapabilities = createSkillsCapabilities({
    sessionId,
    core,
    workspaceRoot,
    snapshot: opts.skillSnapshot,
    capabilitySnapshot,
  })
  const workspaceCapabilities = createWorkspaceCapabilities({
    toolName: opts.toolName,
    core,
    guards,
    progress,
    inputGuards,
  })

  const ctx: ToolContext = {
    sessionId,
    signal,
    progress,
    ...(opts.contextCompaction ? { contextCompaction: opts.contextCompaction } : {}),
    ...planCapabilities,
    ...skillsCapabilities,
    ...workspaceCapabilities,
    ...createHistoryCapabilities(core.persistence.dependencies().agentHistory, workspaceRoot),
    ...createVisionCapabilities({
      capability: core.config.viewImage,
      signal,
      readWorkspaceImage: workspaceCapabilities.readWorkspaceImage,
      guards,
      progress,
    }),
    ...createOutputCapabilities({ sessionId, signal, currentRun: currentRunGuard, core }),

    async callTool(name, args): Promise<ToolResult> {
      if (!capabilitySnapshot.allowsTool(name)) return sessionToolCapabilityDeniedResult()
      const schema = runToolCatalog.loadSchema(name)
      if (!schema || (enforceHostCapabilities
        && schema.runtime === 'server' && !hostHasLocalCapabilities)) {
        return runToolUnavailableResult()
      }
      // 当前工具（opts.toolName）也在调用链上 —— A 调 A、或 A→B→A，都应在子工具 execute 启动**之前**
      // 就判出环/超深（否则递归的 execute 会先跑一遍、重复副作用，codex P2）。
      const chain = [...stack, opts.toolName]
      if (chain.includes(name)) return { ok: false, error: `tool cycle: ${name}` }
      if (chain.length >= MAX_TOOL_DEPTH) return { ok: false, error: 'tool depth exceeded' }
      const childCtx = buildToolContext({
        sessionId,
        runId,
        signal,
        callId, // 子调用的进度沿用父 callId（同一条 tool_call 的活动）
        toolName: name,
        toolArgs: args,
        stack: chain,
        agentPath: opts.agentPath,
        getParentTranscript: opts.getParentTranscript,
        inheritedSkillFiles: opts.inheritedSkillFiles,
        inheritedSkillIds: opts.inheritedSkillIds,
        inheritedSkillContents: opts.inheritedSkillContents,
        delegateRuntime: opts.delegateRuntime,
        capabilitySnapshot,
        skillSnapshot: opts.skillSnapshot,
        toolCatalog: runToolCatalog,
        hostHasLocalCapabilities,
        core, // 同 agent 互调链共用同一实例（子 ctx 也走本次 core）。
      })
      const result = await core.tools.run(
        name,
        args,
        childCtx,
        runToolCatalog.registrationVersion(name),
      )
      // pause 只能是顶层 model 触发，不许经 callTool 冒泡（避免嵌套暂停语义混乱，§8）。
      if ('pause' in result) return { ok: false, error: 'cannot pause inside callTool' }
      return result
    },
  }

  if (opts.delegateRuntime && capabilitySnapshot.allowsTool('delegate_agent')) {
    attachDelegationCapabilities(ctx, {
      sessionId,
      runId,
      callId,
      toolName: opts.toolName,
      toolArgs: opts.toolArgs,
      agentPath: opts.agentPath,
      getParentTranscript: opts.getParentTranscript,
      inheritedSkillFiles: opts.inheritedSkillFiles,
      inheritedSkillIds: opts.inheritedSkillIds,
      inheritedSkillContents: opts.inheritedSkillContents,
      delegateRuntime: opts.delegateRuntime,
      capabilitySnapshot,
      toolCatalog: runToolCatalog,
      hostHasLocalCapabilities,
      enforceHostCapabilities,
      core,
      guards,
      progress,
      inputGuards,
    })
  }

  return ctx
}
