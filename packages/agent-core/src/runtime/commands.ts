// P-R3：runtime 命令 API —— UI ↔ runtime 的唯一边界。
// ---------------------------------------------------------------------------
// 当前 UI/runtime 契约：
//   · U1 runtime/UI 隔离：UI 只做两件事 —— 读 atom + 调这里导出的命令。UI 绝不直接
//     setter atom / import writers / 碰 store 实例；这些命令是唯一入口边界。
//   · U2 命令不收 store：每个命令都不接 `store` 参数，内部自取 rootStore /
//     getSessionStore(activeId)。UI 拿不到、也不需要 store 引用。
//   · U7 signal 全穿透 + 失败降级：sendMessage 起 run 时把 abort signal 穿到 model；
//     model 失败由 runSession 内部降级（不抛崩 UI）。
// 本文只编排 rootStore / sessionStore / abortRegistry / modelRun / checkpointWriters，
// 不 import 任何 UI（U1）。
//
// 【实例化 · 第 3 期 · createCommands 工厂】命令不再写死 defaultCore，而是收进一个
//   createCommands(core = defaultCore) 工厂：每条命令闭包捕获传入的 core，把所有 store/registry/
//   abort/config 访问一律经这个 core（内部命令互调也走同工厂的成员，保证同 core）。模块级导出
//   （UI/测试 import 的那些同名命令）= createCommands() 的成员（默认 core=defaultCore），故现有
//   import 一行不用改、默认路径行为逐字不变。第 3 期 createCore（runtime/core/createCore.ts）就靠
//   createCommands(隔离实例) 造出「只在自己那套 store/registry/abort/config 上跑」的命令集 —— 与
//   defaultCore 完全隔离，这是「能嵌两次」的收口证明（见 createCore.test.ts）。

import {
  workspacesAtom,
  activeWorkspaceIdAtom,
  expandedWorkspaceIdsAtom,
  workspaceSettingsOpenIdsAtom,
  sessionsAtom,
  activeSessionIdAtom,
} from '../state/rootStore'
import { itemsAtom, runAtom, checkpointsAtom } from '../state/sessionAtoms'
import { getPlan, setPlan } from '../state/planWriters'
import { PlanRuntime } from '../planning/runtime'
import { EvaluationRuntime } from '../evaluation/runtime'
import { appendItem, patchRun, setItems, setRun } from '../state/sessionWriters'
import {
  getPendingQuestionAnswers,
  clearPendingQuestionAnswers,
  setPendingQuestionAnswer,
  removePendingArtifact,
  pruneBrowserCardsAfter,
  pruneRuntimeTranscriptEventsAfter,
  addAlwaysAllowedTool,
  enqueueUserMessage,
  setComposerDraft,
  setWithdrawnTurnNotice,
} from '../state/transientAtoms'
import type { AskUserAnswerValue } from '../state/transientAtoms'
import { jumpToCheckpoint, rewindBeforeCheckpoint } from '../state/checkpointWriters'
import {
  persistCurrentRunRecovery,
  resumeInterruptedSession,
  resumePlanSession,
  runSession,
  runToolLoop,
} from './modelRun'
// 【实例化 · 第 2/3 期穿线】命令绑定 core（默认 defaultCore）：函数体内用工厂参数 core 显式替换旧的
//   模块全局（rootStore / getSessionStore / beginRun/abortRun/endRun），并把 core 传进
//   runSession/runToolLoop/writers 的 core 参数。abort 经 core.abort.*，配置经 core.config。默认
//   core=defaultCore 时行为逐字不变（defaultCore 就是穿线前的模块全局单例）；createCore 可绑定隔离 core。
//   configureCommands 仍写 defaultCore.config（注入 env key 到全局默认实例）；隔离实例的 config 由
//   createCore({ config }) 在构造时预置，其命令读自己的 core.config。
import { defaultCore, type RuntimeConfig, type CoreInstance } from './core/coreInstance'
import {
  persistSessions,
  persistWorkspaces,
  persistDeleteSession,
  persistTruncate,
} from './persistenceBridge'
import { newId } from './newId'
import type {
  ModelSettings,
  SessionMeta,
  ConversationItem,
  WorkspaceMeta,
} from '../state/core.type'
import { DEFAULT_DEEPSEEK_MODEL } from '@web-agent/ai'
import { addEvent, getActiveSpan, runTraceKey } from '../observability/trace'
import { isDangerousTool, isMcpTool } from './dangerousTools'
import { getExecutionRuntime } from '../execution/runtime'
import { activeExecutionNodeIdsAtom, executionGraphAtom } from '../execution/graph'
import {
  DEFAULT_WORKSPACE_NAME,
  deriveWorkspaceName,
  normalizeWorkspaceRoot,
} from '../state/workspaceState'

// ===========================================================================
// 运行时配置注入 —— apiKey 来源（config 通电：defaultCore.config 是 CoreInstance 第五个视图）
// ===========================================================================
// 【实例化 · 第 2 期 · config 通电】运行时配置不再是本模块私有的 runtimeConfig，而是 defaultCore.config
//   （CoreInstance 的第五个字段）。configureCommands 用 Object.assign 就地改写 defaultCore.config 的字段
//   —— config 引用只读、字段可变，绝不替换引用（否则与别处持有的同一引用漂移成两份）。main.tsx 照旧调
//   configureCommands 注入 env key，行为逐字不变，只是背后写进 defaultCore.config。
//   【第 3 期】configureCommands 专注注入【全局默认实例】的 config，故仍写死 defaultCore.config，不进
//   createCommands 工厂（工厂命令读 core.config；隔离实例的 config 走 createCore({ config }) 构造预置）。

// 简介：注入/更新【默认实例】运行时配置（apiKey / 可选 fetchImpl）→ 就地写进 defaultCore.config。
// 详情：Object.assign 浅合并，只覆盖传入字段；未传的保持原值。就地改字段、不替换 config 引用。
export function configureCommands(cfg: Partial<RuntimeConfig>): void {
  Object.assign(defaultCore.config, cfg)
}

// ===========================================================================
// 模块级常量 & 纯函数 —— 不依赖 core，供工厂内命令与外部（UI/测试）共用
// ===========================================================================

// 会话默认标题 —— newSession 的兜底名，也是自动标题（TT1）判断「用户尚未取名」的哨兵值。
export const DEFAULT_SESSION_TITLE = '新对话'

// 简介：从用户输入派生会话标题（TT2，纯函数）。
// 详情：压缩空白（连串空白折成单空格 + 去首尾）→ Array.from 按 code point 截前 12 字
//   （防 emoji/增补平面字符被从代理对中间截断成乱码）→ 截断则加 …。
//   派生为空（纯空白输入）返回空串，由调用方决定保留默认名。
export function deriveSessionTitle(input: string): string {
  const compact = input.replace(/\s+/g, ' ').trim()
  if (!compact) return ''
  const chars = Array.from(compact)
  if (chars.length <= 12) return compact
  return `${chars.slice(0, 12).join('')}…`
}

const SIDE_EFFECT_TOOL_NAMES = new Set(['run_task'])

function currentTurnStartIndex(items: ConversationItem[]): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].item.role === 'user') return i
  }
  return -1
}

function currentTurnHasSideEffects(items: ConversationItem[]): boolean {
  for (const { item } of items) {
    if (item.role !== 'assistant') continue
    for (const toolCall of item.tool_calls ?? []) {
      const name = toolCall.function.name
      if (isDangerousTool(name) || SIDE_EFFECT_TOOL_NAMES.has(name)) return true
    }
  }
  return false
}

// 从对话历史里取「最后一条 assistant」的 ask_user_question tool_call id（找不到返回 undefined）。
// 该 id 即暂停时未回填的 ask_user ToolItem 的 tool_call_id，resume 用它把答案回填给 model。
function findAskUserToolCallId(items: ConversationItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i].item
    if (item.role === 'assistant') {
      return item.tool_calls?.find((toolCall) => toolCall.function.name === 'ask_user_question')?.id
    }
  }
  return undefined
}

// ===========================================================================
// createCommands 工厂 —— 把全部命令绑定到传入的 core（默认 defaultCore）
// ===========================================================================

// 简介：造一组绑定到 `core` 的命令。默认 core=defaultCore → 模块级导出即绑默认实例（行为零变化）；
//   createCore 传隔离实例 → 命令只在那套 store/registry/abort/config 上跑（互不串台）。
// 详情：命令间互调（sendMessage→renameSession）走同一工厂闭包内的成员，保证同 core。
export function createCommands(core: CoreInstance = defaultCore) {
  // =========================================================================
  // 工作区与会话命令
  // =========================================================================

  function createWorkspaceMeta(opts?: { name?: string; rootPath?: string }): WorkspaceMeta {
    const id = newId()
    const now = Date.now()
    const rootPath = normalizeWorkspaceRoot(opts?.rootPath)
    return {
      id,
      name: opts?.name?.trim() || deriveWorkspaceName(rootPath) || DEFAULT_WORKSPACE_NAME,
      rootPath,
      createdAt: now,
      updatedAt: now,
    }
  }

  function activateWorkspace(id: string): void {
    const workspace = core.rootStore.getter(workspacesAtom)[id]
    if (!workspace) return
    core.rootStore.setter(activeWorkspaceIdAtom, id)
    core.rootStore.setter(expandedWorkspaceIdsAtom, (prev) => ({ ...prev, [id]: true }))
    const currentSessionId = core.rootStore.getter(activeSessionIdAtom)
    const sessions = core.rootStore.getter(sessionsAtom)
    if (sessions[currentSessionId]?.workspaceId === id) return
    const latest = Object.values(sessions)
      .filter((session) => session.workspaceId === id)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    core.rootStore.setter(activeSessionIdAtom, latest?.id ?? '')
  }

  // 新建一级工作区。相同非空目录只激活已有工作区，避免侧栏重复。
  function newWorkspace(opts?: { name?: string; rootPath?: string }): string {
    const rootPath = normalizeWorkspaceRoot(opts?.rootPath)
    if (rootPath) {
      const existing = Object.values(core.rootStore.getter(workspacesAtom))
        .find((workspace) => normalizeWorkspaceRoot(workspace.rootPath) === rootPath)
      if (existing) {
        activateWorkspace(existing.id)
        return existing.id
      }
    }
    const workspace = createWorkspaceMeta({ ...opts, rootPath })
    core.rootStore.setter(workspacesAtom, (prev) => ({ ...prev, [workspace.id]: workspace }))
    core.rootStore.setter(activeWorkspaceIdAtom, workspace.id)
    core.rootStore.setter(
      expandedWorkspaceIdsAtom,
      (prev) => ({ ...prev, [workspace.id]: true }),
    )
    core.rootStore.setter(activeSessionIdAtom, '')
    persistWorkspaces()
    return workspace.id
  }

  function selectWorkspace(id: string): void {
    activateWorkspace(id)
  }

  function toggleWorkspaceExpanded(id: string): void {
    if (!core.rootStore.getter(workspacesAtom)[id]) return
    core.rootStore.setter(expandedWorkspaceIdsAtom, (prev) => ({
      ...prev,
      [id]: !(prev[id] ?? false),
    }))
  }

  function toggleWorkspaceSettings(id: string): void {
    if (!core.rootStore.getter(workspacesAtom)[id]) return
    activateWorkspace(id)
    core.rootStore.setter(workspaceSettingsOpenIdsAtom, (prev) => (
      prev[id] ? {} : { [id]: true }
    ))
  }

  function renameWorkspace(id: string, name: string): void {
    const trimmed = name.trim()
    if (!trimmed) return
    const chars = Array.from(trimmed)
    const nextName = chars.length > 48
      ? `${chars.slice(0, 47).join('')}…`
      : trimmed
    let changed = false
    core.rootStore.setter(workspacesAtom, (prev) => {
      const workspace = prev[id]
      if (!workspace || workspace.name === nextName) return prev
      changed = true
      return {
        ...prev,
        [id]: { ...workspace, name: nextName, updatedAt: Date.now() },
      }
    })
    if (changed) persistWorkspaces()
  }

  // 简介：给指定会话改名（TT3）—— ghost guard + 不可变更新 + updatedAt 前进 + 落盘。
  // 详情：照 setWorkspaceRoot 范式。trim 后空串 → no-op（编辑框取消语义，保留原名）；
  //   超长入参按 code point 截 48 字防爆列表。自动标题（sendMessage/TT1）内部复用本命令。
  function renameSession(id: string, title: string): void {
    const trimmed = title.trim()
    if (!trimmed) return
    const next = Array.from(trimmed).slice(0, 48).join('')
    let changed = false
    core.rootStore.setter(sessionsAtom, (prev) => {
      const meta = prev[id]
      if (!meta) return prev // ghost guard：会话未登记 → no-op
      changed = true
      return { ...prev, [id]: { ...meta, title: next, updatedAt: Date.now() } }
    })
    if (changed) persistSessions() // D-4：会话元信息变更 → 覆盖式落盘（fire-and-forget）。
  }

  // 简介：新建会话 → 登记 rootStore.sessionsAtom → 建每会话 store → 设为 active，返回 id。
  // 详情：默认 settings 为 deepseek + 默认模型；opts.settings / opts.title 可覆盖。
  function newSession(opts?: {
    title?: string
    settings?: ModelSettings
    workspaceId?: string
  }): string {
    let workspaceId = opts?.workspaceId
    const workspaces = core.rootStore.getter(workspacesAtom)
    if (!workspaceId || !workspaces[workspaceId]) {
      const activeWorkspaceId = core.rootStore.getter(activeWorkspaceIdAtom)
      workspaceId = workspaces[activeWorkspaceId] ? activeWorkspaceId : undefined
    }
    if (!workspaceId) {
      const workspace = createWorkspaceMeta()
      workspaceId = workspace.id
      core.rootStore.setter(workspacesAtom, (prev) => ({ ...prev, [workspace.id]: workspace }))
    }
    const id = newId()
    const settings: ModelSettings = opts?.settings ?? {
      vendor: 'deepseek',
      model: DEFAULT_DEEPSEEK_MODEL,
    }
    const now = Date.now()
    const meta: SessionMeta = {
      id,
      title: opts?.title ?? DEFAULT_SESSION_TITLE,
      settings,
      createdAt: now,
      updatedAt: now,
      workspaceId,
    }
    core.rootStore.setter(sessionsAtom, (prev) => ({ ...prev, [id]: meta }))
    core.rootStore.setter(workspacesAtom, (prev) => {
      const workspace = prev[workspaceId]
      if (!workspace) return prev
      return { ...prev, [workspaceId]: { ...workspace, updatedAt: now } }
    })
    core.createSessionStore(id)
    core.rootStore.setter(activeWorkspaceIdAtom, workspaceId)
    core.rootStore.setter(
      expandedWorkspaceIdsAtom,
      (prev) => ({ ...prev, [workspaceId]: true }),
    )
    core.rootStore.setter(activeSessionIdAtom, id)
    persistWorkspaces()
    persistSessions() // D-4：会话列表变更 → 覆盖式落盘（fire-and-forget）。
    return id
  }

  // 简介：切换当前激活会话。
  function selectSession(id: string): void {
    const session = core.rootStore.getter(sessionsAtom)[id]
    if (session?.workspaceId && core.rootStore.getter(workspacesAtom)[session.workspaceId]) {
      core.rootStore.setter(activeWorkspaceIdAtom, session.workspaceId)
      core.rootStore.setter(expandedWorkspaceIdsAtom, (prev) => ({
        ...prev,
        [session.workspaceId!]: true,
      }))
    }
    core.rootStore.setter(activeSessionIdAtom, id)
  }

  // 简介：删除会话 —— 不可变从 sessionsAtom 删 id + 丢弃其 store。
  // 详情：若删的是当前 active，active 落到剩余任一 id（Object.keys 第一个）或空串。
  function removeSession(id: string): void {
    // 先中断该会话可能在跑的 run（否则 abortRegistry 的 controller 泄漏、model 请求白跑）。
    core.abort.abortRun(id)
    core.rootStore.setter(sessionsAtom, (prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    core.dropSessionStore(id)
    if (core.rootStore.getter(activeSessionIdAtom) === id) {
      const activeWorkspaceId = core.rootStore.getter(activeWorkspaceIdAtom)
      const remaining = Object.values(core.rootStore.getter(sessionsAtom))
        .filter((session) => session.workspaceId === activeWorkspaceId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
      core.rootStore.setter(activeSessionIdAtom, remaining[0]?.id ?? '')
    }
    // D-4：会话列表变更 → 覆盖式落盘；被删会话的历史 checkpoint 单独清盘（均 fire-and-forget）。
    persistSessions()
    persistDeleteSession(id)
  }

  // 简介：修改当前一级工作区根目录；同一工作区中的所有会话立即共享。
  function setWorkspaceRoot(root: string): void {
    const id = core.rootStore.getter(activeWorkspaceIdAtom)
    if (!id) return
    const rootPath = normalizeWorkspaceRoot(root)
    let changed = false
    core.rootStore.setter(workspacesAtom, (prev) => {
      const workspace = prev[id]
      if (!workspace || workspace.rootPath === rootPath) return prev
      changed = true
      return {
        ...prev,
        [id]: {
          ...workspace,
          name: workspace.name === DEFAULT_WORKSPACE_NAME && rootPath
            ? deriveWorkspaceName(rootPath)
            : workspace.name,
          rootPath,
          updatedAt: Date.now(),
        },
      }
    })
    if (changed) persistWorkspaces()
  }

  // 简介：切换当前会话的工具授权模式，并随 SessionMeta 持久化。
  function setApprovalMode(mode: 'confirm' | 'auto'): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return
    let changed = false
    core.rootStore.setter(sessionsAtom, (prev) => {
      const meta = prev[id]
      if (!meta || (meta.toolApprovalMode ?? 'confirm') === mode) return prev
      changed = true
      return { ...prev, [id]: { ...meta, toolApprovalMode: mode, updatedAt: Date.now() } }
    })
    if (changed) persistSessions()
  }

  // =========================================================================
  // 运行命令
  // =========================================================================

  // 简介：对当前 active 会话起一轮 run（U5 单轮切片）。
  // 详情：无 active / 空输入 / 会话未登记 → no-op。apiKey 按会话 vendor 取（glm→glmApiKey，
  //   否则 deepseekApiKey）。beginRun 拿 signal（U7 穿透）；runSession 失败内部降级；
  //   finally 里 endRun 清理（只删自己那个 controller）。
  function sendMessage(input: string): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    const content = input.trim()
    if (!id || !content) return
    const meta = core.rootStore.getter(sessionsAtom)[id]
    if (!meta) return

    const run = core.getSessionStore(id).store.getter(runAtom)
    const status = run?.status
    // 模型请求或工具批次仍在运行时，不另起 run；把输入绑定到当前 run，交给 modelRun 在
    // tool-call/result 闭合后的安全边界提升为普通 user 消息。
    if ((status === 'running' || status === 'awaiting_tool') && run) {
      enqueueUserMessage(id, {
        id: newId(),
        createdAt: Date.now(),
        content,
        targetRunId: run.runId,
      }, core)
      persistCurrentRunRecovery(id, core)
      return
    }

    // 结构化决策暂停仍必须走对应卡片，不能用普通消息绕过未回填的 tool call。
    if (
      status === 'waiting_user' ||
      status === 'waiting_confirmation'
      || status === 'waiting_plan_approval'
      || status === 'interrupted'
    )
      return

    // 自动标题（TT1）：标题仍为默认值时，用本条输入派生一次标题（复用 renameSession 走
    //   ghost guard/updatedAt/落盘）。用户改过名（≠默认）绝不覆盖；同会话第二条消息时标题
    //   已非默认，天然不再触发。派生为空（理论上上面已挡空输入）→ 保留默认名。
    if (meta.title === DEFAULT_SESSION_TITLE) {
      const derived = deriveSessionTitle(content)
      if (derived) renameSession(id, derived)
    }

    const apiKey = meta.settings.vendor === 'glm' ? core.config.glmApiKey : core.config.deepseekApiKey
    const signal = core.abort.beginRun(id)
    void runSession(id, content, { signal, apiKey, fetchImpl: core.config.fetchImpl, core }).finally(() =>
      core.abort.endRun(id, signal),
    )
  }

  // 计划 evaluator 不能跨进程存活。无论是旧版 continuePlan，还是新版通用中断恢复，
  // 都先把 orphaned evaluating 原子回滚为 in_progress，再交给同一模型循环继续。
  function recoverInterruptedPlanEvaluation(id: string): boolean {
    let plan = getPlan(id)
    if (!plan) return true
    const orphanedEvaluations = plan.stages.filter((stage) => stage.status === 'evaluating')
    if (orphanedEvaluations.length > 0) {
      const evaluation = new EvaluationRuntime({
        get: () => getPlan(id),
        set: (next) => setPlan(id, next),
      }, Date.now)
      for (const stage of orphanedEvaluations) {
        const recovered = evaluation.abortStageEvaluation(
          plan.id,
          plan.revision,
          stage.id,
          '应用或模型请求在验收完成前中断，继续执行时自动恢复',
        )
        if (!recovered.ok) return false
        plan = recovered.plan
      }
    }
    return true
  }

  // 简介：继续最新 checkpoint 中因应用重启而中断的普通任务或计划任务。
  // 详情：沿用持久化 runId/turnId 与同一轮工作快照，不追加用户消息；真正执行由
  // resumeInterruptedSession 负责安全闭合孤儿 tool_call 后复用原模型循环。
  function continueInterruptedRun(): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return
    const run = core.getSessionStore(id).store.getter(runAtom)
    if (run?.status !== 'interrupted') return
    if (!recoverInterruptedPlanEvaluation(id)) return

    const meta = core.rootStore.getter(sessionsAtom)[id]
    if (!meta) return
    const apiKey = meta.settings.vendor === 'glm' ? core.config.glmApiKey : core.config.deepseekApiKey
    const signal = core.abort.beginRun(id)
    void resumeInterruptedSession(id, {
      signal,
      apiKey,
      fetchImpl: core.config.fetchImpl,
      core,
    }).finally(() => core.abort.endRun(id, signal))
  }

  // 旧版 recovery 曾在提交阶段验收后只写入 awaiting_tool，而没有持久化
  // pendingExecutionId。若对应的后台执行随后取消，这个 run 会永久占住计划的
  // “正在运行”状态。只在确认同一 run 没有任何活跃执行节点时，才把它恢复为
  // interrupted；有节点时保持等待，避免并发重复续跑。
  function recoverOrphanedAwaitingToolRun(id: string): boolean {
    const store = core.getSessionStore(id).store
    const run = store.getter(runAtom)
    if (run?.status !== 'awaiting_tool' || run.pendingExecutionId) return false

    const graph = store.getter(executionGraphAtom)
    const hasActiveExecution = store.getter(activeExecutionNodeIdsAtom)
      .some((executionId) => graph.nodes[executionId]?.runId === run.runId)
    if (hasActiveExecution) return false

    patchRun(id, { status: 'interrupted', pendingExecutionId: undefined }, core)
    persistCurrentRunRecovery(id, core)
    return true
  }

  // 简介：恢复一个已经持久化、但当前没有运行中 run 的旧版计划。
  // 详情：新版 checkpoint 若恢复出了 interrupted run，则转交通用恢复入口并保持原 runId；
  // 没有 recovery 的历史 checkpoint 仍走原计划恢复兼容路径。
  function continuePlan(): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return

    const status = core.getSessionStore(id).store.getter(runAtom)?.status
    if (status === 'awaiting_tool' && recoverOrphanedAwaitingToolRun(id)) {
      continueInterruptedRun()
      return
    }
    if (status === 'interrupted') {
      continueInterruptedRun()
      return
    }
    if (
      status === 'running'
      || status === 'awaiting_tool'
      || status === 'waiting_user'
      || status === 'waiting_confirmation'
      || status === 'waiting_plan_approval'
    ) return

    const plan = getPlan(id)
    if (!plan || !['approved', 'active', 'evaluating'].includes(plan.status)) return
    if (!plan.stages.some((stage) => ['pending', 'in_progress', 'evaluating'].includes(stage.status))) return
    if (!recoverInterruptedPlanEvaluation(id)) return

    const meta = core.rootStore.getter(sessionsAtom)[id]
    if (!meta) return
    const apiKey = meta.settings.vendor === 'glm' ? core.config.glmApiKey : core.config.deepseekApiKey
    const signal = core.abort.beginRun(id)
    void resumePlanSession(id, {
      signal,
      apiKey,
      fetchImpl: core.config.fetchImpl,
      core,
    }).finally(() => core.abort.endRun(id, signal))
  }

  // 简介：esc —— 中断当前 active 会话正在跑的 run。
  function stopRun(): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return
    const store = core.getSessionStore(id).store
    const run = store.getter(runAtom)
    core.abort.abortRun(id)
    if (!run || !['running', 'awaiting_tool'].includes(run.status)) return

    // 后台 execution 启动后，父模型请求会正常 return 并释放自己的 AbortController。
    // 因此停止不能只 abort 模型请求，还要先把 run 置 stopped 阻断完成回调的自动续跑，
    // 再取消对应 execution（它会继续向下中断 evaluator 子树）。
    patchRun(id, {
      status: 'stopped',
      pendingExecutionId: undefined,
    }, core)

    const executionIds = new Set<string>()
    if (run.pendingExecutionId) executionIds.add(run.pendingExecutionId)

    // 兼容修复前已经落盘/正在运行的会话：旧 RunState 没有 pendingExecutionId。
    // execution graph 仍保留 runId，因此可找出该 run 下活跃的顶层 batch 并逐个取消。
    const graph = store.getter(executionGraphAtom)
    for (const executionId of store.getter(activeExecutionNodeIdsAtom)) {
      const node = graph.nodes[executionId]
      if (node?.runId === run.runId && node.type === 'agent-batch' && !node.parentId) {
        executionIds.add(executionId)
      }
    }

    const executionRuntime = getExecutionRuntime(core)
    for (const executionId of executionIds) {
      executionRuntime.cancel(id, executionId)
    }
  }

  // 简介：撤回当前未完成轮并把该轮用户输入放回 Composer 草稿。
  // 详情：仅处理 run.status==='stopped' 的当前 active 会话；成功完成的轮次走 checkpoint 回退，不走这里。
  //   该操作只撤回对话 transcript，不承诺撤销已执行的外部副作用；若本轮出现过危险/执行类工具，会写入提示。
  function withdrawCurrentTurnToDraft(): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return
    const store = core.getSessionStore(id).store
    const run = store.getter(runAtom)
    if (run?.status !== 'stopped') return

    const items = store.getter(itemsAtom)
    const start = currentTurnStartIndex(items)
    if (start < 0) return
    const user = items[start].item
    if (user.role !== 'user') return

    // 新版 stopped 轮会先收成 [已停止] checkpoint，保证刷新不丢且消息气泡能显示回退。
    // 这里若命中该快照，必须走标准 checkpoint 撤回链路，把内存和盘上的目标轮一起截掉；
    // 否则仅 slice items 会让这轮在刷新后从持久化 checkpoint 中重新出现。
    const checkpoints = store.getter(checkpointsAtom)
    for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
      const checkpoint = checkpoints[index]
      const checkpointUserIndex = currentTurnStartIndex(checkpoint.items)
      if (checkpoint.items[checkpointUserIndex]?.id !== items[start].id) continue
      revertTurnToDraft(checkpoint.turnIndex)
      return
    }

    // 兼容修复前遗留、尚未形成 checkpoint 的 stopped 轮。
    core.abort.abortRun(id)
    const turnItems = items.slice(start)
    const sideEffects = currentTurnHasSideEffects(turnItems)
    const cutoffCreatedAt = items[start].createdAt
    setItems(id, items.slice(0, start), core)
    setRun(id, undefined, core)
    setComposerDraft(id, user.content, core)
    pruneBrowserCardsAfter(id, cutoffCreatedAt - 1, core)
    pruneRuntimeTranscriptEventsAfter(id, cutoffCreatedAt - 1, core)
    setWithdrawnTurnNotice(id, {
      id: newId(),
      createdAt: Date.now(),
      text: sideEffects
        ? '已撤回本轮对话并放回输入框；本轮已触发过工具，外部副作用不会被自动撤销。'
        : '已撤回本轮对话并放回输入框。',
      sideEffects,
    }, core)
  }

  // 简介：ask_user 恢复（T-7/TK7）—— 用户填完答案后续跑 pending run。
  // 详情：仅当当前 active 会话 run 处于 waiting_user 时生效。从 itemsAtom 找最后一条 assistant 的
  //   ask_user_question tool_call（取其 id=tool_call_id）；找不到则容错清 pendingQuestion + 落回
  //   running 后返回（不续跑）。否则读并清 pendingQuestionAnswers → 回填 ask_user 的 ToolItem（把
  //   {answers} 当 tool result）→ 落回 running + 清 pendingQuestion → 复用 pending run 的 runId、
  //   beginRun 拿新 signal，走 runToolLoop 续跑（apiKey 按会话 vendor 取，与 sendMessage 同逻辑；
  //   finally endRun 清理）。
  function resumeWithAnswers(): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return
    const run = core.getSessionStore(id).store.getter(runAtom)
    if (run?.status !== 'waiting_user') return

    const pendingDecision = run.pendingUserDecision
    // 新状态直接保存未回填的 callId；fallback 兼容只有 pendingQuestion 的旧状态。
    const toolCallId = pendingDecision?.callId
      ?? findAskUserToolCallId(core.getSessionStore(id).store.getter(itemsAtom))
    // 容错：找不到 ask_user 调用（异常/被回退过）→ 清 pendingQuestion + 落回 running，不续跑。
    if (!toolCallId) {
      patchRun(id, { status: 'running', pendingQuestion: undefined, pendingUserDecision: undefined }, core)
      return
    }

    // 读答案 + 清答案（避免旧答案污染下一次等待用户输入）。
    const answers = getPendingQuestionAnswers(id, core)
    clearPendingQuestionAnswers(id, core)
    addEvent('agent.resume.answers', {
      span: getActiveSpan(runTraceKey(id, run.runId)),
      attrs: { sessionId: id, runId: run.runId, callId: toolCallId, answers_count: Object.keys(answers).length },
    })

    // 回填 ask_user 的 ToolItem：把 {answers} 作为 tool result 回给 model。
    appendItem(id, {
      id: newId(),
      createdAt: Date.now(),
      planStageId: pendingDecision?.origin.stageId,
      item: { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify({ answers }) },
    }, core)

    // 落回 running + 清 pendingQuestion，复用 pending run 的 runId 续跑同一条 run。
    patchRun(id, { status: 'running', pendingQuestion: undefined, pendingUserDecision: undefined }, core)

    const meta = core.rootStore.getter(sessionsAtom)[id]
    const apiKey = meta?.settings.vendor === 'glm' ? core.config.glmApiKey : core.config.deepseekApiKey
    const signal = core.abort.beginRun(id)
    void runToolLoop(id, run.runId, { signal, apiKey, fetchImpl: core.config.fetchImpl, core }).finally(() =>
      core.abort.endRun(id, signal),
    )
  }

  // 简介：危险工具确认恢复（S4-B）—— 用户在确认卡片点「允许」/「拒绝」后续跑 pending run。镜像 resumeWithAnswers。
  // 详情：仅当当前 active 会话 run 处于 waiting_confirmation 时生效。取 pendingToolConfirmation；缺失则容错清空 +
  //   落回 running 后返回（不续跑）。approved=true → 复用 pending run 的 runId，把该危险工具作为 resumeToolCall
  //   传进 runToolLoop（循环开头执行它、回填结果，再进正常多轮）；always=true 则先把该工具记进本 session
  //   「一律允许」集合（后续不再确认）。approved=false → 给该 tool_call 回填 {error} result 后重入循环，
  //   让 model 据此改道。apiKey 按会话 vendor 取（与 sendMessage 同逻辑）；finally endRun 清理。
  function confirmTool(approved: boolean, always?: boolean): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return
    const run = core.getSessionStore(id).store.getter(runAtom)
    if (run?.status !== 'waiting_confirmation') return

    const pending = run.pendingToolConfirmation
    // 容错：无 pending（异常/被回退过）→ 清 pendingToolConfirmation + 落回 running，不续跑。
    if (!pending) {
      addEvent('agent.confirmation.missing_pending', {
        span: getActiveSpan(runTraceKey(id, run.runId)),
        attrs: { sessionId: id, runId: run.runId },
      })
      patchRun(id, { status: 'running', pendingToolConfirmation: undefined }, core)
      return
    }
    // MCP 工具必须逐次确认；即便绕过 UI 直接传 always=true，也不能写入 session 授权。
    const registrationStillCurrent = pending.registrationVersion === undefined
      || core.tools.registrationVersion(pending.toolName) === pending.registrationVersion
    const rememberApproval = approved
      && Boolean(always)
      && registrationStillCurrent
      && pending.risk !== 'critical'
      && !pending.irreversible
      && !isMcpTool(pending.toolName)
    addEvent('agent.confirmation.decision', {
      span: getActiveSpan(runTraceKey(id, run.runId)),
      attrs: {
        sessionId: id,
        runId: run.runId,
        toolName: pending.toolName,
        callId: pending.callId,
        approved,
        always: rememberApproval,
        registrationVersion: pending.registrationVersion,
        registrationStillCurrent,
      },
    })

    const meta = core.rootStore.getter(sessionsAtom)[id]
    const apiKey = meta?.settings.vendor === 'glm' ? core.config.glmApiKey : core.config.deepseekApiKey

    if (!approved) {
      // 拒绝：给该 tool_call 回填 error result（序列合法），落回 running，重入循环让 model 改道。
      appendItem(id, {
        id: newId(),
        createdAt: Date.now(),
        item: { role: 'tool', tool_call_id: pending.callId, content: JSON.stringify({ error: '用户拒绝执行该工具' }) },
      }, core)
      patchRun(id, { status: 'running', pendingToolConfirmation: undefined }, core)
      const signal = core.abort.beginRun(id)
      void runToolLoop(id, run.runId, { signal, apiKey, fetchImpl: core.config.fetchImpl, core }).finally(() =>
        core.abort.endRun(id, signal),
      )
      return
    }

    // 允许：可选「本 session 一律允许该工具」→ 记瞬态集合；落回 running，重入循环并让其先执行被确认工具。
    if (rememberApproval) {
      addAlwaysAllowedTool(id, pending.toolName, core)
    }
    patchRun(id, { status: 'running', pendingToolConfirmation: undefined }, core)
    const signal = core.abort.beginRun(id)
    void runToolLoop(id, run.runId, {
      signal,
      apiKey,
      fetchImpl: core.config.fetchImpl,
      resumeToolCall: pending,
      core,
    }).finally(() => core.abort.endRun(id, signal))
  }

  // 计划审批是宿主专用命令：模型没有对应 approve tool，因而不能自批。
  // 注：getPlan/setPlan 尚未收 core（planning 本期不穿线），故计划读写仍落 defaultCore —— 隔离实例上
  //   approvePlan 的计划态会漂到 defaultCore，属已知缺口（本期不碰 planning/evaluation）；默认实例无影响。
  function approvePlan(approved: boolean): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return
    const run = core.getSessionStore(id).store.getter(runAtom)
    const pending = run?.pendingPlanApproval
    if (run?.status !== 'waiting_plan_approval' || !pending) return

    const runtime = new PlanRuntime({ get: () => getPlan(id), set: (plan) => setPlan(id, plan) }, Date.now, newId)
    const decision = runtime.approve(pending.planId, pending.revision, approved)
    const content = decision.ok
      ? JSON.stringify(approved ? { approved: true, plan: decision.plan } : { error: '用户拒绝了计划', plan: decision.plan })
      : JSON.stringify({ error: decision.error })
    appendItem(id, {
      id: newId(),
      createdAt: Date.now(),
      item: { role: 'tool', tool_call_id: pending.callId, content },
    }, core)
    patchRun(id, { status: 'running', pendingPlanApproval: undefined }, core)

    const meta = core.rootStore.getter(sessionsAtom)[id]
    const apiKey = meta?.settings.vendor === 'glm' ? core.config.glmApiKey : core.config.deepseekApiKey
    const signal = core.abort.beginRun(id)
    void runToolLoop(id, run.runId, { signal, apiKey, fetchImpl: core.config.fetchImpl, core }).finally(() => core.abort.endRun(id, signal))
  }

  // 最终结果验收同样是宿主专用命令；显式 planId/revision 让切会话和双击都 fail-closed。
  // 注：同 approvePlan，getPlan/setPlan 未收 core → 计划态落 defaultCore（planning 本期不穿线）。
  function acceptPlanResult(planId: string, revision: number, accepted: boolean): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return
    const runtime = new EvaluationRuntime({ get: () => getPlan(id), set: (plan) => setPlan(id, plan) }, Date.now)
    runtime.acceptPlan(planId, revision, accepted)
  }

  // =========================================================================
  // 卡片交互命令（P8-c）—— UI 卡片的答案回填 / 产物丢弃
  // =========================================================================

  // 简介：记录当前 active 会话某个 question 的答案（AskUserQuestionCard onChange 调用）。
  // 详情：取 activeId，无 active → no-op。写入走 transientAtoms 的 setter（内部已带 ghost guard）。
  function answerQuestion(questionId: string, value: AskUserAnswerValue): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return
    setPendingQuestionAnswer(id, questionId, value, core)
  }

  // 简介：从指定会话丢弃一个 save_file 待保存产物（SaveArtifact 保存成功后调用）。
  // 详情：收显式 sessionId（PF4）—— 卡片点击时捕获归属会话，异步保存期间 active 可能被切走，
  //   故不取 active，只删传入 sessionId 的产物（removePendingArtifact 内部带 ghost guard）。
  function discardArtifact(sessionId: string, artifactId: string): void {
    removePendingArtifact(sessionId, artifactId, core)
  }

  // =========================================================================
  // 回退命令
  // =========================================================================

  // 简介：对当前 active 会话回退到第 turnIndex 轮（截断式回退）。
  function revertToTurn(turnIndex: number): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return
    // 先校验 turnIndex 合法（越界/负数 → 整体 no-op）。否则 jumpToCheckpoint 内存里 no-op、但
    // persistTruncate(id, -1) 会走 truncateAfter(id, -1) 把盘上「全部」checkpoint 删光，刷新丢历史
    // （codex P2）。校验读该会话 store 的 checkpointsAtom；幽灵会话取到 [] → 任何 index 都越界 → no-op。
    const checkpoints = core.getSessionStore(id).store.getter(checkpointsAtom)
    if (turnIndex < 0 || turnIndex >= checkpoints.length) return
    // 回退前先停当前 run —— 否则回退改了 items/checkpoints，正在跑的 run 完成时又
    // appendItem/commitCheckpoint 会污染回退后的状态（与 removeSession 的破坏性命令前先 abort 一致）。
    core.abort.abortRun(id)
    jumpToCheckpoint(id, turnIndex, core)
    // 剪掉「被丢弃轮次」产生的 browser 卡片（codex P2）：browserCards 不进 checkpoint 快照，
    //   jumpToCheckpoint 只截断 items，需按回退点 checkpoint 的 createdAt 把之后的卡片一并剪掉，
    //   否则回退后仍渲染已废弃轮的卡片。
    pruneBrowserCardsAfter(id, checkpoints[turnIndex].createdAt, core)
    pruneRuntimeTranscriptEventsAfter(id, checkpoints[turnIndex].createdAt, core)
    persistTruncate(id, turnIndex) // D-4：截断式回退 → 同步截断持久化 checkpoint（fire-and-forget）。
  }

  // 简介：撤回第 turnIndex 轮到其用户消息之前，并把原输入放回 Composer 草稿。
  // 详情：与 revertToTurn「保留目标轮结束快照」不同，本命令会丢弃目标轮本身，供消息气泡上的
  //   「回退」入口使用。对话记录可以截断，已执行的工具外部副作用不能自动撤销，故按需显示提示。
  function revertTurnToDraft(turnIndex: number): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return
    const store = core.getSessionStore(id).store
    const checkpoints = store.getter(checkpointsAtom)
    const checkpoint = checkpoints[turnIndex]
    if (!checkpoint) return

    const checkpointUserIndex = currentTurnStartIndex(checkpoint.items)
    const targetUser = checkpoint.items[checkpointUserIndex]
    if (!targetUser || targetUser.item.role !== 'user') return

    const currentItems = store.getter(itemsAtom)
    const currentUserIndex = currentItems.findIndex((item) => item.id === targetUser.id)
    const discardedItems = currentUserIndex >= 0
      ? currentItems.slice(currentUserIndex)
      : checkpoint.items.slice(checkpointUserIndex)
    const sideEffects = currentTurnHasSideEffects(discardedItems)

    // stopRun 除中断模型请求外，还会取消该 run 下仍在执行的后台 execution；随后清掉 run，
    // 避免撤回后残留 stopped/done 状态或迟到写回污染已经截断的 transcript。
    stopRun()
    rewindBeforeCheckpoint(id, turnIndex, core)
    setRun(id, undefined, core)
    setComposerDraft(id, targetUser.item.content, core)
    pruneBrowserCardsAfter(id, targetUser.createdAt - 1, core)
    pruneRuntimeTranscriptEventsAfter(id, targetUser.createdAt - 1, core)
    setWithdrawnTurnNotice(id, {
      id: newId(),
      createdAt: Date.now(),
      text: sideEffects
        ? '已回退到该轮之前，原输入已放回输入框；已触发过工具，外部副作用不会被自动撤销。'
        : '已回退到该轮之前，原输入已放回输入框。',
      sideEffects,
    }, core)
    // persistTruncate 保留 <= turnIndex 的快照；这里目标轮也要删除，故传前一轮。
    // turnIndex=0 时传 -1 是有意清空该会话的全部 checkpoint。
    persistTruncate(id, turnIndex - 1)
  }

  return {
    newWorkspace,
    selectWorkspace,
    toggleWorkspaceExpanded,
    toggleWorkspaceSettings,
    renameWorkspace,
    renameSession,
    newSession,
    selectSession,
    removeSession,
    setWorkspaceRoot,
    setApprovalMode,
    sendMessage,
    continueInterruptedRun,
    continuePlan,
    stopRun,
    withdrawCurrentTurnToDraft,
    resumeWithAnswers,
    confirmTool,
    approvePlan,
    acceptPlanResult,
    answerQuestion,
    discardArtifact,
    revertToTurn,
    revertTurnToDraft,
  }
}

// createCommands 的返回形状 —— UI ↔ runtime 的命令面（configureCommands 除外，见其说明）。
// 用 ReturnType 从工厂返回值推导，零漂移（新增/改命令自动同步到类型）。
export type CommandApi = ReturnType<typeof createCommands>

// ===========================================================================
// 模块级命令导出 —— 绑定 defaultCore（行为逐字不变，现有 UI/测试 import 一行不用改）
// ===========================================================================
// createCommands() 无参 → core=defaultCore，成员即穿线前的模块级命令。UI/测试照旧
//   `import { sendMessage, ... } from './commands'` 拿到的就是绑定默认实例的那一组。
export const {
  newWorkspace,
  selectWorkspace,
  toggleWorkspaceExpanded,
  toggleWorkspaceSettings,
  renameWorkspace,
  renameSession,
  newSession,
  selectSession,
  removeSession,
  setWorkspaceRoot,
  setApprovalMode,
  sendMessage,
  continueInterruptedRun,
  continuePlan,
  stopRun,
  withdrawCurrentTurnToDraft,
  resumeWithAnswers,
  confirmTool,
  approvePlan,
  acceptPlanResult,
  answerQuestion,
  discardArtifact,
  revertToTurn,
  revertTurnToDraft,
} = createCommands()
