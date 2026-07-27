// TK5 瞬态 atom —— 会话 store 内共享单例 key（值随 store 隔离，绝不分桶）。
// ---------------------------------------------------------------------------
// 对齐旧 src/agent/state 的 pendingArtifacts / browserCards / pendingQuestionAnswers，
// 但按 agentNew 既定架构（sessionAtoms 范式，C3）落到「每会话一个 store」：
//   · 这些 atom 只是共享 key，值真正存在各自 session store 里 —— 天然隔离，
//     无需也禁止把它们做成 `Record<sessionId, T>` 分桶。
//   · 都是「临时 UI 产物」，不进持久化快照（对齐旧 D2 语义）。
// 写入器沿用 sessionWriters 范式（C7）：内部取 getSessionStore(id).store；
// 先做 ghost guard（会话未在 rootStore 登记 → no-op，防给幽灵会话写内容）；
// 所有更新不可变（替换数组/对象，C4）。
//
// 【实例化 · 第 2 期穿线】本文件所有导出的写入函数（add/remove/prune/set/upsert/clear 一类）都在
//   既有参数之后加了默认参数 core（CoreInstance，默认 defaultCore）：函数体内一律经
//   core.rootStore / core.getSessionStore(id) 读写，不再摸模块全局 rootStore / getSessionStore。
//   默认值就是 defaultCore——而 defaultCore.rootStore 正是 rootStore.ts 导出的那个 Store 引用、
//   defaultCore.getSessionStore 也是 sessionStore.ts 导出函数背后委托的同一实现，所以不传 core
//   的调用点（现状全部调用点）行为逐字不变。传入独立 core（如 createCoreInstance() 造的实例）时，
//   读写只落在那个实例自己的 store，与 defaultCore 互不污染（第 3 期隔离雏形）。
//   两个纯读函数 getPendingQuestionAnswers / isToolAlwaysAllowed 第 2 期未穿（任务只要求
//   「写入函数」穿线），仍走模块级 getSessionStore（= defaultCore 视图）。
//
// 【实例化 · 第 3 期穿线】补上面留的两个读函数缺口：getPendingQuestionAnswers / isToolAlwaysAllowed
//   也加了尾参 core（CoreInstance，默认 defaultCore），内部 getSessionStore(id) → core.getSessionStore(id)。
//   默认值仍是 defaultCore，不传 core 的调用点（commands.ts / modelRun.ts / toolContext.ts 现有全部
//   调用）行为逐字不变；传入独立 core 时只读该 core 自己的 session store，与 defaultCore 互不污染。
//   本文件的写入函数第 2 期已穿好 core，本期未动。

import { atom } from '@einfach/core'
import { sessionsAtom } from './rootStore'
import { defaultCore, type CoreInstance } from '../runtime/core/coreInstance'
import type { ConversationItem } from './core.type'

// save_file 工具暂存、等用户手势落盘的文件产物（临时 UI 态，不持久化）。
export interface PendingArtifact {
  id: string
  filename: string
  content: string
  mimeType?: string
}

// browser_action render_card 渲染进 transcript 的卡片（临时 UI 态，不持久化）。
export interface BrowserCard {
  id: string
  createdAt: number
  title: string
  body?: string
}

// AskUserQuestion 单个答案值（照抄旧 types 语义）。
export type AskUserAnswerValue = string | string[] | boolean

// 工具进度条目（临时 UI 态，不持久化）：显示「某个工具调用正在干啥」。
// callId = 该 tool_call 的 id（唯一），toolName 便于 UI 标注，text 是工具经 ctx.progress 给的文案。
export interface ToolActivity {
  callId: string
  toolName: string
  text: string
}

// runtime transcript 调试事件（临时 UI 态，不持久化）：展示不适合进入 ModelItem 历史、
// 但自用调试时必须可见的步骤，例如 system 注入、tools manifest 注入。
export type RuntimeTranscriptEventKind = 'system_injection' | 'tool_manifest'

export interface RuntimeTranscriptEvent {
  id: string
  createdAt: number
  kind: RuntimeTranscriptEventKind
  title: string
  summary?: string
  detail?: string
}

// 当前 LLM 流式输出的 UI 快照。itemsAtom 只保留一个稳定占位条目，流式正文在这里低频更新，
// 避免每个 delta 都替换整段会话历史并触发消息索引、计划索引和 Markdown 全量重算。
export interface AssistantStreamState {
  runId: string
  item: ConversationItem
}

export interface WithdrawnTurnNotice {
  id: string
  createdAt: number
  text: string
  sideEffects: boolean
}

// AI 正在运行时由用户追加的输入。消息先留在会话级瞬态队列，等 runtime 到达安全边界后
// 再转成普通 user ConversationItem，避免插进尚未闭合的 assistant tool_call / tool result 中间。
export interface QueuedUserMessage {
  id: string
  createdAt: number
  content: string
  targetRunId: string
}

export interface ContextRoleStats {
  count: number
  chars: number
  estimatedTokens: number
}

export interface ContextUsageStats {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  cacheHitTokens?: number
  cacheMissTokens?: number
  cacheMissSource?: 'provider' | 'derived' | 'unknown'
  cacheWriteTokens?: number
  cacheHitRate?: number
}

export interface ContextCacheStats {
  lane: 'main' | 'subagent' | 'evaluator' | 'distill:core' | 'distill:child_brief'
  profileId: string
  epoch: number
  epochReason:
    | 'initial'
    | 'profile_changed'
    | 'dynamic_control_changed'
    | 'history_inserted_before_dynamic_tail'
    | 'compaction_projection_changed'
    | 'request_projection_changed'
  protocolVersion: string
  toolSetFingerprint: string
  laneScopeFingerprint: string
  systemFingerprint: string
  requestProjectionFingerprint: string
  compactionBoundary: 'full-history' | 'compacted-history'
  metricsStatus: 'pending' | 'available' | 'unavailable' | 'request_failed' | 'cancelled'
}

export interface ContextCacheTotals {
  profileId: string
  epoch: number
  measuredRequests: number
  hitTokens: number
  missTokens: number
  hitRate?: number
}

export interface ContextStatsSnapshot {
  id: string
  createdAt: number
  vendor: string
  model: string
  runId: string
  turnId: string
  llmTurn: number
  messagesCount: number
  toolsCount: number
  systemChars: number
  messagesChars: number
  toolsChars: number
  totalChars: number
  estimatedTokens: number
  roles: {
    system: ContextRoleStats
    user: ContextRoleStats
    assistant: ContextRoleStats
    tool: ContextRoleStats
  }
  toolNames: string[]
  usage?: ContextUsageStats
  cache?: ContextCacheStats
  cacheTotals?: ContextCacheTotals
  finishReason?: string | null
  responseModel?: string
}

// 简介：当前会话的待保存文件产物。
// 详情：值随 store 隔离——每个 session store 各持一份 PendingArtifact[]，非分桶。
export const pendingArtifactsAtom = atom<PendingArtifact[]>([])

// 简介：当前会话的浏览器卡片。
// 详情：值随 store 隔离——每个 session store 各持一份 BrowserCard[]，非分桶。
export const browserCardsAtom = atom<BrowserCard[]>([])

// 简介：当前会话的 AskUserQuestion 待提交答案（questionId → value）。
// 详情：值随 store 隔离——每个 session store 各持一份 Record，非分桶。
export const pendingQuestionAnswersAtom = atom<Record<string, AskUserAnswerValue>>({})

// 简介：当前会话正在跑的工具进度（按 callId）。
// 详情：值随 store 隔离；harness 经 ctx.progress 上写、工具跑完清掉。UI 读它渲染「工具正在干啥」。
export const toolActivityAtom = atom<ToolActivity[]>([])

// 简介：当前会话的 runtime transcript 调试事件。
// 详情：值随 store 隔离；只服务 UI 展示，不进 checkpoint、不参与 model messages。
export const runtimeTranscriptEventsAtom = atom<RuntimeTranscriptEvent[]>([])

// 简介：当前会话正在生成的 assistant 消息。
// 详情：只服务 UI，不进 checkpoint、不参与 model messages；runId 用于阻止旧 run 清掉新 run 的流消息。
export const assistantStreamAtom = atom<AssistantStreamState | undefined>(undefined)

// 简介：当前会话四类注入卡片（system / 自定义指令 / skill 清单 / tools）各自最近一次
//   记录时的内容指纹，供 runtime 判断"相对上一次记录是否变化"（只在变化时记新卡片）。
// 详情：值随 store 隔离，与 runtimeTranscriptEventsAtom 同店同生命周期——都不持久化，
//   应用刷新/重启后二者一起清空（届时可见 transcript 本身也是空的，下一轮各重记一次不构成
//   重复；同一存活期内的连续多次 run/turn 才是本设计要解决的重复源）。
//   customInstructions 用 string | null 区分「从未出现过」（undefined）与「出现过、现已被
//   清空」（null）两种缺失态，供调用方决定是否需要补一条「已清除」事件。
export interface TranscriptInjectionFingerprints {
  system?: string
  customInstructions?: string | null
  /** 全量 skill 清单（进稳定前缀）的内容指纹：只随 registry 注册态变化，不随本轮输入变。 */
  skillManifest?: string
  toolsFingerprint?: string
  toolsCount?: number
}

// 简介：当前会话四类注入卡片的判重指纹。
// 详情：只服务 runtime 判重，不进 checkpoint、不持久化。
export const transcriptInjectionFingerprintsAtom = atom<TranscriptInjectionFingerprints>({})

// 简介：当前会话已展开的「思考过程」分组（group key → 是否展开）。
// 详情：只保存用户的展开选择；虚拟列表的高度、可视范围等 DOM 测量状态不进入 atom。
export const expandedTranscriptGroupsAtom = atom<Record<string, boolean>>({})

// 简介：当前会话对计划阶段详情的显式展开选择（stage id → 是否展开）。
// 详情：未出现的 id 仍由阶段状态决定默认值，例如执行中阶段默认展开。
export const expandedPlanStagesAtom = atom<Record<string, boolean>>({})

// 简介：当前会话最近一次 LLM 调用的上下文统计。
// 详情：只记录 system/messages/tools 的轻量统计和 provider usage；不进 messages、不持久化、不回发给 model。
export const contextStatsAtom = atom<ContextStatsSnapshot | undefined>(undefined)

// 简介：当前会话 Composer 草稿。
// 详情：值随 store 隔离；用于撤回未完成轮后把上一条用户输入放回输入框。
export const composerDraftAtom = atom<string>('')

// 简介：当前会话等待注入正在运行 run 的用户输入（FIFO）。
// 详情：每个 session 自有 Store，因此这里只需要一个数组 atom，不按 sessionId 做大对象分桶。
export const queuedUserMessagesAtom = atom<QueuedUserMessage[]>([])

// 简介：撤回当前未完成轮后的提示。
// 详情：值随 store 隔离；sideEffects=true 表示只撤回对话记录，不承诺撤销已执行的外部副作用。
export const withdrawnTurnNoticeAtom = atom<WithdrawnTurnNotice | undefined>(undefined)

// 简介：本 session「一律允许」的危险工具名集合（S4-B）。
// 详情：用户在确认卡片勾选「本 session 一律允许该工具」后写入；tool 循环命中即跳过后续确认。
//   值随 store 隔离；临时 UI 态，不持久化（刷新即恢复「每次都确认」的安全默认）。
export const alwaysAllowedToolsAtom = atom<string[]>([])

// ghost guard：会话未在 core.rootStore 登记 → 后续写入应 no-op（C7）。
function sessionMissing(id: string, core: CoreInstance): boolean {
  return !core.rootStore.getter(sessionsAtom)[id]
}

/**
 * 往该会话暂存一个 save_file 文件产物（不可变，产生新数组）。
 * 会话未登记则 no-op（ghost guard）。core 默认 defaultCore，语义见文件头。
 */
export function addPendingArtifact(
  id: string,
  artifact: PendingArtifact,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) {
    return
  }
  core.getSessionStore(id).store.setter(pendingArtifactsAtom, (prev) => [...prev, artifact])
}

/**
 * 从该会话移除指定 artifactId 的 save_file 文件产物（不可变，产生新数组）。
 * 会话未登记则 no-op（ghost guard）；artifactId 不存在时数组内容不变、不崩。
 * core 默认 defaultCore，语义见文件头。
 */
export function removePendingArtifact(
  id: string,
  artifactId: string,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) {
    return
  }
  core.getSessionStore(id).store.setter(pendingArtifactsAtom, (prev) =>
    prev.filter((a) => a.id !== artifactId),
  )
}

/**
 * 往该会话追加一张浏览器卡片（不可变，产生新数组）。
 * 会话未登记则 no-op（ghost guard）。core 默认 defaultCore，语义见文件头。
 */
export function addBrowserCard(
  id: string,
  card: BrowserCard,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) {
    return
  }
  core.getSessionStore(id).store.setter(browserCardsAtom, (prev) => [...prev, card])
}

/**
 * 丢弃该会话中 createdAt 晚于 `createdAt` 的浏览器卡片（不可变，产生新数组）。
 * 会话未登记则 no-op（ghost guard）。
 * 用途：截断式回退时，browserCards 不进 checkpoint 快照，需按回退点时间戳把「被丢弃轮次」
 *   产生的卡片一并剪掉，否则回退后仍会渲染已废弃轮的卡片（codex P2）。保留 `<=` 即回退到的
 *   那一轮（及更早）的卡片留下，之后的剪掉。core 默认 defaultCore，语义见文件头。
 */
export function pruneBrowserCardsAfter(
  id: string,
  createdAt: number,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) {
    return
  }
  core.getSessionStore(id).store.setter(browserCardsAtom, (prev) =>
    prev.filter((card) => card.createdAt <= createdAt),
  )
}

/**
 * 记录该会话某个 questionId 的答案（不可变，替换成新对象）。
 * 会话未登记则 no-op（ghost guard）。core 默认 defaultCore，语义见文件头。
 */
export function setPendingQuestionAnswer(
  id: string,
  questionId: string,
  value: AskUserAnswerValue,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) {
    return
  }
  core.getSessionStore(id).store.setter(pendingQuestionAnswersAtom, (prev) => ({
    ...prev,
    [questionId]: value,
  }))
}

/**
 * 读取该会话已收集的 AskUserQuestion 答案（无答案时为空对象）。
 * core 默认 defaultCore：不传时读模块全局那份（行为逐字不变）；传入独立 core 只读该 core 自己的 session store。
 */
export function getPendingQuestionAnswers(
  id: string,
  core: CoreInstance = defaultCore,
): Record<string, AskUserAnswerValue> {
  return core.getSessionStore(id).store.getter(pendingQuestionAnswersAtom)
}

/**
 * 写入/更新某工具调用的进度条目（按 callId upsert，不可变）。会话未登记则 no-op（ghost guard）。
 * core 默认 defaultCore，语义见文件头。
 */
export function upsertToolActivity(
  id: string,
  activity: ToolActivity,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) {
    return
  }
  core.getSessionStore(id).store.setter(toolActivityAtom, (prev) => {
    const index = prev.findIndex((entry) => entry.callId === activity.callId)
    if (index < 0) return [...prev, activity]
    const next = [...prev]
    next[index] = activity
    return next
  })
}

/**
 * 清掉某工具调用的进度条目（该工具跑完时）。会话未登记则 no-op（ghost guard）。
 * core 默认 defaultCore，语义见文件头。
 */
export function removeToolActivity(
  id: string,
  callId: string,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) {
    return
  }
  core.getSessionStore(id).store.setter(toolActivityAtom, (prev) => prev.filter((entry) => entry.callId !== callId))
}

/**
 * 往该会话追加一条 runtime transcript 调试事件（不可变，产生新数组）。
 * 会话未登记则 no-op（ghost guard）。core 默认 defaultCore，语义见文件头。
 */
export function addRuntimeTranscriptEvent(
  id: string,
  event: RuntimeTranscriptEvent,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) {
    return
  }
  core.getSessionStore(id).store.setter(runtimeTranscriptEventsAtom, (prev) => [...prev, event])
}

/**
 * 更新当前 assistant 流消息。会话未登记时 no-op；相同 item id 会替换瞬态快照，
 * 不触碰持久化的 itemsAtom。
 */
export function setAssistantStream(
  id: string,
  stream: AssistantStreamState,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) {
    return
  }
  core.getSessionStore(id).store.setter(assistantStreamAtom, stream)
}

/**
 * 仅当 runId（以及可选 itemId）仍匹配时清除流消息，避免迟到的旧请求清掉新 run 的输出。
 */
export function clearAssistantStream(
  id: string,
  runId: string,
  itemId?: string,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) {
    return
  }
  core.getSessionStore(id).store.setter(assistantStreamAtom, (current) => {
    if (!current || current.runId !== runId) return current
    if (itemId !== undefined && current.item.id !== itemId) return current
    return undefined
  })
}

/**
 * 丢弃该会话中 createdAt 晚于 `createdAt` 的 runtime transcript 调试事件。
 * 用途同 pruneBrowserCardsAfter：截断回退后不展示被丢弃轮次的旁路调试记录。
 * core 默认 defaultCore，语义见文件头。
 */
export function pruneRuntimeTranscriptEventsAfter(
  id: string,
  createdAt: number,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) {
    return
  }
  core.getSessionStore(id).store.setter(runtimeTranscriptEventsAtom, (prev) =>
    prev.filter((event) => event.createdAt <= createdAt),
  )
}

/**
 * 读取该会话四类注入卡片当前的判重指纹（未记录过任何一类时为空对象）。
 * core 默认 defaultCore：不传时读模块全局那份；传入独立 core 只读该 core 自己的 session store。
 */
export function getTranscriptInjectionFingerprints(
  id: string,
  core: CoreInstance = defaultCore,
): TranscriptInjectionFingerprints {
  return core.getSessionStore(id).store.getter(transcriptInjectionFingerprintsAtom)
}

/**
 * 浅合并更新该会话的注入卡片判重指纹。会话未登记则 no-op（ghost guard）。
 * core 默认 defaultCore，语义见文件头。
 */
export function patchTranscriptInjectionFingerprints(
  id: string,
  patch: Partial<TranscriptInjectionFingerprints>,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) {
    return
  }
  core.getSessionStore(id).store.setter(transcriptInjectionFingerprintsAtom, (prev) => ({ ...prev, ...patch }))
}

/**
 * 设置或清除该会话最近一次 LLM 上下文统计。会话未登记则 no-op（ghost guard）。
 * core 默认 defaultCore，语义见文件头。
 */
export function setContextStats(
  id: string,
  stats: ContextStatsSnapshot | undefined,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) {
    return
  }
  core.getSessionStore(id).store.setter(contextStatsAtom, stats)
}

/**
 * 设置该会话 Composer 草稿。会话未登记则 no-op（ghost guard）。core 默认 defaultCore，语义见文件头。
 */
export function setComposerDraft(
  id: string,
  draft: string,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) {
    return
  }
  core.getSessionStore(id).store.setter(composerDraftAtom, draft)
}

/**
 * 把一条用户输入排进当前会话的运行中队列。会话未登记则 no-op。
 */
export function enqueueUserMessage(
  id: string,
  message: QueuedUserMessage,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) {
    return
  }
  core.getSessionStore(id).store.setter(queuedUserMessagesAtom, (prev) => [...prev, message])
}

/**
 * 原子取走属于指定 run 的排队输入，供 runtime 在安全边界按 FIFO 提升为普通 user item。
 * 其它 run 的输入原样保留，避免旧异步回调误消费新 run 的消息。
 */
export function takeQueuedUserMessages(
  id: string,
  runId: string,
  core: CoreInstance = defaultCore,
): QueuedUserMessage[] {
  if (sessionMissing(id, core)) {
    return []
  }
  const store = core.getSessionStore(id).store
  const queued = store.getter(queuedUserMessagesAtom)
  const taken = queued.filter((message) => message.targetRunId === runId)
  if (taken.length > 0) {
    store.setter(
      queuedUserMessagesAtom,
      queued.filter((message) => message.targetRunId !== runId),
    )
  }
  return taken
}

/**
 * 设置或清除该会话撤回提示。会话未登记则 no-op（ghost guard）。core 默认 defaultCore，语义见文件头。
 */
export function setWithdrawnTurnNotice(
  id: string,
  notice: WithdrawnTurnNotice | undefined,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) {
    return
  }
  core.getSessionStore(id).store.setter(withdrawnTurnNoticeAtom, notice)
}

/**
 * 清空该会话的 AskUserQuestion 答案（不可变，置为空对象）。
 * 会话未登记则 no-op（ghost guard）。core 默认 defaultCore，语义见文件头。
 */
export function clearPendingQuestionAnswers(id: string, core: CoreInstance = defaultCore): void {
  if (sessionMissing(id, core)) {
    return
  }
  core.getSessionStore(id).store.setter(pendingQuestionAnswersAtom, {})
}

/**
 * 把某危险工具加进该会话的「一律允许」集合（S4-B，去重，不可变）。会话未登记则 no-op（ghost guard）。
 * core 默认 defaultCore，语义见文件头。
 */
export function addAlwaysAllowedTool(
  id: string,
  toolName: string,
  core: CoreInstance = defaultCore,
): void {
  // MCP 授权只对单次调用有效；状态写入器也拒绝直接调用，避免绕过命令层。
  if (toolName.startsWith('mcp__') || sessionMissing(id, core)) {
    return
  }
  core.getSessionStore(id).store.setter(alwaysAllowedToolsAtom, (prev) =>
    prev.includes(toolName) ? prev : [...prev, toolName],
  )
}

/**
 * 该会话是否已「一律允许」某危险工具（S4-B）。会话未登记 → 取到 [] → false。
 * core 默认 defaultCore：不传时读模块全局那份（行为逐字不变）；传入独立 core 只读该 core 自己的 session store。
 */
export function isToolAlwaysAllowed(
  id: string,
  toolName: string,
  core: CoreInstance = defaultCore,
): boolean {
  // 即使旧状态或测试代码直接污染了 atom，消费端也不能把 MCP 当作 session 授权。
  if (toolName.startsWith('mcp__')) return false
  return core.getSessionStore(id).store.getter(alwaysAllowedToolsAtom).includes(toolName)
}
