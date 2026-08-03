// 多轮 lazy-tool 对话 run —— 把用户输入送模型，按 model 决策循环调工具，直到最终答案。
// ---------------------------------------------------------------------------
// 主循环契约：多轮 lazy-tool 循环 + ask_user 暂停/恢复。
//   · TK1 itemsAtom 直存：assistant(tool_calls) 与 tool result 直接 appendItem 进 itemsAtom，
//     每轮重新 `items.map(it=>it.item)` 重发；不用 continuation blob。
//   · TK3 manifest-only + lazy schema：稳定前缀给出当前环境的全量工具摘要（仅名字+简介）；
//     model 可调用的 function 仍只有 request_tool_schema + 本轮已加载 visible tools。完整
//     schema 经 ensureToolLoaded 懒加载、只随顶层 tools 下发，禁止预加载、禁止进消息历史。
//     加载有【两个】等价入口：显式 request_tool_schema，以及模型直接调用某个未加载工具——
//     后者被闸门就地转成同一次 ensureToolLoaded（本次调用不执行），见下方闸门处的长注释。
//   · TK4 skill 走 tool：稳定前缀只放全量 skill 清单元数据（buildSkillManifestText），
//     正文与资源不进 prompt，一律经 skill_read。
//   · TK6 tool 错误不打断：runRuntimeTool 内部把失败封 {error} JSON 回给 model，loop 继续。
//   · TK7 ask_user 可多次中断：每个新 tool call 都可暂停，答案按当前 callId 精确回填。
//   · TK8 每步守卫：每次 model 调用后写回前 isCurrentRun + ghost guard；MAX_AGENT_TURNS 上限。
//   · TK9 一轮 = 一个 checkpoint：中间 tool items 属同一轮，最终 assistant 后 commit 一次。
//   · U7 signal 全穿透 + 失败降级：AbortError→'stopped'；其它→'error'；绝不抛崩。
// 本文只编排 writers + api + 纯 helper（modelTurn），不持有/接收 store（U2），不 import UI（U1）。
//
// 【实例化 · 第 2 期穿线】runSession / runToolLoop 的 opts 加了可选 core（CoreInstance，默认 defaultCore）：
//   本文件里【每一处】原本摸模块全局的地方（rootStore / getSessionStore / toolRegistry）都改成读传入
//   core 的字段（core.rootStore / core.getSessionStore(id) / core.tools），调 writer 时把 core 作尾参传下，
//   建 toolContext / makeCoreCtx 时把 core 传进去。私有 helper（currentTurnItems /
//   createAssistantStreamWriter / appendToolResult 等）一律加【无默认值】的 core 形参 —— 编译期强制每个
//   调用点显式传，堵住「漏穿一处、默认路径无症状、只有双实例才串台」的隐患。默认 core=defaultCore＝穿线
//   前的模块全局单例（rootStore.ts / sessionStore.ts / tools/registry.ts 都已是 defaultCore 视图），故不传
//   core 的调用点（commands.ts 现有全部调用 + 所有现有测试）行为逐字不变。
//   ★ 剩余隔离缺口（默认路径无影响，双实例时仍可能落 defaultCore）★：
//     · createDelegateAgentRuntime + 子 agent 委派路径；
//     · Planning getter/writer；
//     · persistence bridge 的默认兼容门面（主循环已按 core 写入）。

import { isTauri } from '@tauri-apps/api/core'
import { sessionsAtom, workspacesAtom } from '../state/rootStore'
import { resolveSessionWorkspaceRoot } from '../state/workspaceState'
import { buildProjectSkillsBridge } from './projectSkillsBridge'
import { detectHostPlatform } from './hostPlatform'
import { itemsAtom, runAtom, checkpointsAtom, planAtom } from '../state/sessionAtoms'
import { executionGraphAtom } from '../execution/graph'
import { appendItem, setRun, patchRun, updateItem } from '../state/sessionWriters'
import { commitCheckpoint, updateCheckpoint } from '../state/checkpointWriters'
import { readCheckpointState } from '../state/checkpointKind'
import {
  removeToolActivity,
  isToolAlwaysAllowed,
  addRuntimeTranscriptEvent,
  contextStatsAtom,
  queuedUserMessagesAtom,
  setContextStats,
  takeQueuedUserMessages,
  getTranscriptInjectionFingerprints,
  patchTranscriptInjectionFingerprints,
  clearAssistantStream,
  setAssistantStream,
  type ContextCacheTotals,
  type ContextStatsSnapshot,
  type ContextUsageStats,
} from '../state/transientAtoms'
import { classifyToolRisk } from './dangerousTools'
import type { ConversationItem, PendingToolConfirmation, PendingUserDecisionOrigin } from '../state/core.type'
import type { CheckpointState, RunRecoverySnapshot } from '../state/checkpoint.type'
import { normalizeAskUserQuestionPayload } from './askUserQuestion'
import { streamDeepSeek, type DeepSeekChatRequest } from '@web-agent/ai'
import { streamGlm, type GlmChatRequest } from '@web-agent/ai'
import { isAbortError } from '@web-agent/ai'
import { normalizeCacheUsage } from '@web-agent/ai'
import type {
  AssistantItem,
  ModelChatResponse,
  ModelFunctionTool,
  ModelItem,
  ModelResponseMessage,
  ModelStreamDelta,
  SystemItem,
} from '@web-agent/ai'
import type { LoadedTool, ToolResult } from '../tools/types'
import {
  ensureToolLoaded,
  refreshVisibleTools,
  toolRegistrationChangedResult,
  toolSchemaNotLoadedResult,
} from './toolLoading'
import { toolSchemaAutoloadedResult, toolSchemaLoadedResult } from '../tools/schemaResult'
import { buildToolContext } from './toolContext'
// 【实例化 · 第 2 期穿线】core（CoreInstance，默认 defaultCore）决定本 run 用谁的 store/registry/abort。
import { defaultCore, type CoreInstance } from './core/coreInstance'
// parseToolCallArgs 住在 modelTurn（纯 helper 层）—— 主循环与 subagents 的第二条工具循环
// 必须共用同一份「坏 JSON 不执行工具」的判据，各抄一份迟早会漂移。
import {
  buildCustomInstructionsItem,
  buildEnvironmentItem,
  buildSystemItem,
  buildToolManifestText,
  buildTurnTools,
  loadedToolNamesFromHistory,
  MAX_TURN_TOOLS,
  narrowToolCalls,
  parseToolCallArgs,
  searchToolManifestPage,
  toolSetSchemaFingerprint,
  touchRecentToolName,
} from './modelTurn'
// 全量 skill 清单（L1）由 registry 直接产出：内容只依赖注册态，进稳定前缀（阶段 3）。
import { buildSkillManifestText, listSkillSummaries } from '../skills/registry'
// 收尾自查条款与工具失败提醒文案的单一来源（零依赖叶子模块，evals 的 prompt 行为 A/B 也 import 它）。
import {
  toolFailureStreakNotice,
  TOOL_FAILURE_ERROR_PREVIEW_LIMIT,
  TOOL_FAILURE_STREAK_THRESHOLD,
  type ToolFailureStreak,
} from './selfReflectionPrompts'
// estimateTokensFromText 仍留着（buildContextStatsSnapshot 的 role 统计在用，与压缩无关）；
// 压缩本体（compactContext / DEFAULT_KEEP_RECENT_TURNS + 窗口预算常量）已内化进 compactionPlugin。
import { estimateTokensFromText } from './contextCompaction'
// Core 抽离 Stage 2a：把「模型迁移 / finish_reason 三态 / 循环检测」三个关注点搬成插件，接进 loop。
//   · 模型迁移 → migrationPlugin（onRunStart：run 启动把迁移后 settings 归一化写回 sessionsAtom）。
//   · 循环检测 → loopGuardPlugin（onTurnEnd：跨轮重复工具调用累计，达阈值 3 返回终止决策 + trace attrs）。
//   · finish_reason 三态 → finishReasonPlugin（onTurnEnd：补 Case B 标注条目 + 返回终止决策）。
//   · 压缩 → compactionPlugin（transformContext，Stage 1 已接）。
//   onTurnEnd 是 fan-out 槽：loopGuard 注册在 finishReason【之前】——首个 stop 胜且短路，复刻旧代码
//   「循环检测 block 在 finish_reason block 之前」的评估序（实务上两者触发条件互斥、同轮不双发）。
//   危险工具确认 / ask_user 暂停两条挂起/恢复流留 Stage 2b，原样待在下面的 loop 里、一行未动。
import { makeCoreCtx } from './core/coreCtx'
import { assemblePlugins } from './core/pluginApi'
import { fnv1a32 } from './shared/hash'
import { assistantItemFromMessage, stringForStats, tracePreview } from './shared/preview'
import { isCurrentRun } from './shared/runGuards'
import {
  compactionPlugin,
  contextInputBudgetTokens,
  type CompactionRequestDraft,
} from './core/plugins/compactionPlugin'
import { migrationPlugin } from './core/plugins/migrationPlugin'
import {
  finishReasonPlugin,
  FINISH_REASON_ITEM_NOTICES,
} from './core/plugins/finishReasonPlugin'
import { loopGuardPlugin } from './core/plugins/loopGuardPlugin'
import {
  getAbnormalFinishReason,
  type AbnormalFinishReason,
  type TurnEndEvent,
} from './core/loopHooks'
import { formatSubagentTranscript } from '../subagents/distill'
import { ROOT_AGENT_PATH } from '../subagents/path'
import { createDelegateAgentRuntime } from '../subagents/runtime'
import { getExecutionRuntime } from '../execution/runtime'
import { newId } from './newId'
import {
  addEvent,
  bindActiveSpan,
  clearActiveSpan,
  endSpan,
  getActiveSpan,
  runTraceKey,
  startSpan,
} from '../observability/trace'
import type { TraceAttributes, TraceSpan, TraceStatus } from '../observability/types'
import { truncatePayload } from '../observability/redact'
import {
  createContextCacheTracker,
  type ContextCacheProfile,
} from './contextCache'

// 主 Agent 模型轮次上限（不包含 delegate_agent 内部的子 Agent 轮次）。
// 普通对话保持较紧的熔断；执行结构化计划时按阶段数放大预算。轮次只是最后一道保险，
// 重复工具死循环另有 loopGuardPlugin 在连续 3 次时提前拦截。
const DEFAULT_MAX_AGENT_TURNS = 32
const MIN_PLAN_AGENT_TURNS = 64
const PLAN_AGENT_TURNS_PER_STAGE = 24
const MAX_PLAN_AGENT_TURNS = 256
// DeepSeek 会用 HTTP 200 + finish_reason=insufficient_system_resource 表达瞬时容量不足，
// 它不会进入 modelApi 对 429/5xx/网络错误的 HTTP 退避。这里只补一层很窄的协议级恢复：
// 同一模型轮最多额外请求一次，且一旦流式 writer 已经把内容写进会话就绝不重放。
const MAX_DEEPSEEK_INSUFFICIENT_RESOURCE_RETRIES = 1
const EXECUTING_PLAN_STATUSES = new Set(['approved', 'active'])
// LOOP_DETECTION_THRESHOLD / LOOP_DETECTED_ERROR 已随循环检测搬进 loopGuardPlugin（Core 抽离 Stage 2a）。
const STREAM_UPDATE_INTERVAL_MIN_MS = 150
const STREAM_UPDATE_INTERVAL_MAX_MS = 250
const SHELL_TOOLS_REQUIRING_COMMAND = new Set(['shell_macos', 'shell_linux', 'shell_powershell'])
const LLM_TRACE_PREVIEW_LIMIT = 80_000
const LLM_TRACE_PREVIEW_OPTIONS = {
  stringLimit: LLM_TRACE_PREVIEW_LIMIT,
  depth: 8,
  itemLimit: 1_000,
  keyLimit: 400,
}
// 回填给 model 的「坏参数」预览长度：够它认出自己发了什么，又不至于把截断的巨串再塞回上下文。
const ARGS_PREVIEW_LIMIT = 200
// 工具失败软提醒的阈值、错误摘要长度、per-run 计数类型与提醒文案都住在 selfReflectionPrompts.ts
// （零依赖叶子模块）—— evals 的 prompt 行为 A/B 要复用同一份字节与同一个阈值来复刻注入语义，
// 而本文件的模块图（tauri / 持久化桥 / 全部 atoms）不可能被那套离线 eval 直接 import。

// span 收尾状态：中断算 'cancelled'，其余算 'error'。
// 同时看 signal 和错误本身 —— 有些中断（工具内部的超时/级联 abort）不会体现在外层 signal 上，
// 而某些 fetch polyfill 只抛 name==='AbortError' 的普通 Error，故一律走 isAbortError 鸭子类型。
function abortStatus(signal: AbortSignal, err?: unknown): Exclude<TraceStatus, 'running'> {
  return signal.aborted || isAbortError(err) ? 'cancelled' : 'error'
}

function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function responseChars(value: string | null | undefined): number {
  return typeof value === 'string' ? value.length : 0
}

function usageTraceAttrs(usage: ModelChatResponse['usage']): TraceAttributes {
  const attrs: TraceAttributes = {}
  if (typeof usage?.prompt_tokens === 'number') attrs.prompt_tokens = usage.prompt_tokens
  if (typeof usage?.completion_tokens === 'number') attrs.completion_tokens = usage.completion_tokens
  if (typeof usage?.total_tokens === 'number') attrs.total_tokens = usage.total_tokens
  const cache = normalizeCacheUsage(usage)
  if (typeof cache?.hitTokens === 'number') attrs.cache_hit_tk = cache.hitTokens
  if (typeof cache?.missTokens === 'number') attrs.cache_miss_tk = cache.missTokens
  if (typeof cache?.writeTokens === 'number') attrs.cache_write_tk = cache.writeTokens
  if (cache?.missSource) attrs.cache_miss_source = cache.missSource
  const rate = cacheHitRate(cache?.hitTokens, cache?.missTokens)
  if (typeof rate === 'number') attrs.cache_hit_rate = rate
  return attrs
}

function valueKind(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function llmTracePreview(value: unknown): string {
  return truncatePayload(value, LLM_TRACE_PREVIEW_LIMIT, LLM_TRACE_PREVIEW_OPTIONS)
}

// 工具调用签名规范化（isPlainRecord / normalizeForSignature / normalizedArgsSignature /
// toolCallSignature）已随循环检测搬进 loopGuardPlugin（Core 抽离 Stage 2a）。工具执行 trace 的
// argsPreview / resultPreview 由 shared/preview 的 tracePreview 统一生成。

function argsPreviewForModel(raw: string): string {
  return raw.length > ARGS_PREVIEW_LIMIT ? `${raw.slice(0, ARGS_PREVIEW_LIMIT)}...` : raw
}

function toolCallValidationError(toolName: string, args: Record<string, unknown>): string | undefined {
  if (!SHELL_TOOLS_REQUIRING_COMMAND.has(toolName)) return undefined
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  return command ? undefined : `invalid ${toolName}: command (non-empty string) is required`
}

function questionCount(payload: unknown): number | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const questions = (payload as { questions?: unknown }).questions
  return Array.isArray(questions) ? questions.length : undefined
}

function planApprovalPayload(payload: unknown): { planId: string; revision: number } | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const value = payload as Record<string, unknown>
  if (value.kind !== 'plan_approval' || typeof value.planId !== 'string' || typeof value.revision !== 'number') return undefined
  return { planId: value.planId, revision: value.revision }
}

function compactTranscriptText(value: string, limit = 180): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact
}

function transcriptDetail(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

// skill 清单卡片的摘要：清单正文是逐行「name — 触发条件」，展开看 detail 即可；折叠态只报
// 数量与名字。名字与 buildSkillManifestText 同源同序（都取自 registry 注册态、按名字排序）。
function skillManifestSummary(): string {
  const names = listSkillSummaries().map((skill) => skill.name).sort()
  return `清单含 ${names.length} 个 skill：${names.join('、')}`
}

function toolNames(tools: ModelFunctionTool[]): string[] {
  return tools.map((tool) => tool.function.name)
}

// previousCount 传入时（tools 卡片判重命中"变化"、非首次记录）在数量前带上变化前后的对比，
// 如 "3 → 4"；省略或与当前数量相同则退化成旧文案 "暴露 N 个工具：..."。
function toolManifestSummary(tools: ModelFunctionTool[], previousCount?: number): string {
  const names = toolNames(tools)
  const countLabel = previousCount !== undefined && previousCount !== tools.length
    ? `${previousCount} → ${tools.length}`
    : `${tools.length}`
  return compactTranscriptText(`暴露 ${countLabel} 个工具：${names.join('、') || '无'}`)
}

function emptyRoleStats() {
  return { count: 0, chars: 0, estimatedTokens: 0 }
}

function usageStats(usage: ModelChatResponse['usage']): ContextUsageStats | undefined {
  const stats: ContextUsageStats = {}
  if (typeof usage?.prompt_tokens === 'number') stats.promptTokens = usage.prompt_tokens
  if (typeof usage?.completion_tokens === 'number') stats.completionTokens = usage.completion_tokens
  if (typeof usage?.total_tokens === 'number') stats.totalTokens = usage.total_tokens
  const cache = normalizeCacheUsage(usage)
  if (typeof cache?.hitTokens === 'number') stats.cacheHitTokens = cache.hitTokens
  if (typeof cache?.missTokens === 'number') stats.cacheMissTokens = cache.missTokens
  if (typeof cache?.writeTokens === 'number') stats.cacheWriteTokens = cache.writeTokens
  if (cache?.missSource) stats.cacheMissSource = cache.missSource
  const rate = cacheHitRate(cache?.hitTokens, cache?.missTokens)
  if (typeof rate === 'number') stats.cacheHitRate = rate
  return Object.keys(stats).length > 0 ? stats : undefined
}

function cacheHitRate(hitTokens?: number, missTokens?: number): number | undefined {
  if (typeof hitTokens !== 'number' || typeof missTokens !== 'number') return undefined
  const total = hitTokens + missTokens
  return total > 0 ? hitTokens / total : undefined
}

function accumulateCacheTotals(
  previous: ContextCacheTotals | undefined,
  usage: ModelChatResponse['usage'],
  profile: ContextCacheProfile,
): ContextCacheTotals | undefined {
  const scopedPrevious =
    previous?.profileId === profile.profileId && previous.epoch === profile.epoch
      ? previous
      : undefined
  const cache = normalizeCacheUsage(usage)
  if (typeof cache?.hitTokens !== 'number' || typeof cache.missTokens !== 'number') {
    return scopedPrevious
  }

  const hitTokens = (scopedPrevious?.hitTokens ?? 0) + cache.hitTokens
  const missTokens = (scopedPrevious?.missTokens ?? 0) + cache.missTokens
  return {
    profileId: profile.profileId,
    epoch: profile.epoch,
    measuredRequests: (scopedPrevious?.measuredRequests ?? 0) + 1,
    hitTokens,
    missTokens,
    hitRate: cacheHitRate(hitTokens, missTokens),
  }
}

function buildContextStatsSnapshot(args: {
  runId: string
  turnId: string
  llmTurn: number
  vendor: string
  model: string
  messages: ModelItem[]
  tools: ModelFunctionTool[]
  cacheProfile: ContextCacheProfile
  cacheTotals?: ContextCacheTotals
  inputBudgetTokens: number
}): ContextStatsSnapshot {
  const roles: ContextStatsSnapshot['roles'] = {
    system: emptyRoleStats(),
    user: emptyRoleStats(),
    assistant: emptyRoleStats(),
    tool: emptyRoleStats(),
  }

  for (const message of args.messages) {
    const text = stringForStats(message)
    const roleStats = roles[message.role]
    roleStats.count += 1
    roleStats.chars += text.length
    roleStats.estimatedTokens += estimateTokensFromText(text)
  }

  const toolsText = stringForStats(args.tools)
  const messagesChars = roles.system.chars + roles.user.chars + roles.assistant.chars + roles.tool.chars
  const toolsChars = toolsText.length

  return {
    id: newId(),
    createdAt: Date.now(),
    vendor: args.vendor,
    model: args.model,
    runId: args.runId,
    turnId: args.turnId,
    llmTurn: args.llmTurn,
    messagesCount: args.messages.length,
    toolsCount: args.tools.length,
    systemChars: roles.system.chars,
    messagesChars,
    toolsChars,
    totalChars: messagesChars + toolsChars,
    estimatedTokens:
      roles.system.estimatedTokens +
      roles.user.estimatedTokens +
      roles.assistant.estimatedTokens +
      roles.tool.estimatedTokens +
      estimateTokensFromText(toolsText),
    inputBudgetTokens: args.inputBudgetTokens,
    roles,
    toolNames: toolNames(args.tools),
    cache: {
      ...args.cacheProfile,
      metricsStatus: 'pending',
    },
    cacheTotals: args.cacheTotals,
  }
}

function addTranscriptEvent(
  sessionId: string,
  kind: 'system_injection' | 'tool_manifest',
  title: string,
  summary: string,
  detail: unknown,
  core: CoreInstance,
): void {
  addRuntimeTranscriptEvent(sessionId, {
    id: newId(),
    createdAt: Date.now(),
    kind,
    title,
    summary,
    detail: transcriptDetail(detail),
  }, core)
}

function toolResultTrace(result: ToolResult, args?: unknown): {
  status: Exclude<TraceStatus, 'running'>
  attrs: TraceAttributes
  err?: unknown
} {
  const baseAttrs: TraceAttributes = args === undefined ? {} : { args }

  if ('pause' in result) {
    return {
      status: 'ok',
      attrs: { ...baseAttrs, result_kind: 'pause', result: result.pause, question_count: questionCount(result.pause) },
    }
  }
  if (result.ok) {
    return {
      status: 'ok',
      attrs: { ...baseAttrs, result_kind: valueKind(result.data), result: result.data ?? { ok: true } },
    }
  }
  return {
    status: 'error',
    attrs: {
      ...baseAttrs,
      result_kind: 'error',
      result: {
        error: result.error,
        ...(result.code ? { code: result.code } : {}),
        ...(result.hint ? { hint: result.hint } : {}),
        ...(result.retryable !== undefined ? { retryable: result.retryable } : {}),
        ...(result.details !== undefined ? { details: result.details } : {}),
      },
      error: result.error,
    },
    err: result.error,
  }
}

// runId 只回答“是不是同一次运行”，不能回答“这次运行是否还允许继续”。
// 用户停止时会保留 runId、仅把 status 改为 stopped；异步请求若无视 AbortSignal 后返回，
// 只检查 isCurrentRun 会把这个已停止的 run 重新带进下一轮。
function isRunningRun(id: string, runId: string, core: CoreInstance): boolean {
  const currentRunGuard = {
    root: core.rootStore,
    getStore: () => core.getSessionStore(id).store,
    sessionId: id,
    runId,
  }
  if (!isCurrentRun(currentRunGuard)) return false
  return currentRunGuard.getStore().getter(runAtom)?.status === 'running'
}

function currentPlanStageId(id: string, core: CoreInstance): string | undefined {
  const plan = core.getSessionStore(id).store.getter(planAtom)
  return plan?.stages.find((stage) => stage.status === 'in_progress')?.id
}

function pendingDecisionOrigin(
  id: string,
  payload: unknown,
  planStageId: string | undefined,
  core: CoreInstance,
): PendingUserDecisionOrigin {
  const plan = core.getSessionStore(id).store.getter(planAtom)
  if (plan) {
    const phase = plan.status === 'draft' ? 'drafting'
      : plan.status === 'awaiting_approval' ? 'approval'
        : 'executing'
    return {
      surface: 'plan',
      phase,
      planId: plan.id,
      planRevision: plan.revision,
      stageId: planStageId,
    }
  }

  const declaredContext = normalizeAskUserQuestionPayload(payload).context
  return declaredContext?.surface === 'plan'
    ? { surface: 'plan', phase: declaredContext.phase ?? 'drafting' }
    : { surface: 'conversation' }
}

// 计划是独立于聊天 items 持久化的状态；刷新或从旧 checkpoint 恢复后，历史消息里不一定还留着
// create_plan / execute_plan 的结果。每轮把推进协议所需的最小权威快照临时投影给模型，避免它只知道
// “当前阶段进行中”，却拿不到 submit_stage_result 必填的 planId / revision / stageId。
// 快照只进本轮请求，不写回 itemsAtom；阶段产出与验收变化会在下一轮自动取到最新 revision。
function currentPlanContext(id: string, core: CoreInstance): string | undefined {
  const plan = core.getSessionStore(id).store.getter(planAtom)
  if (!plan || !EXECUTING_PLAN_STATUSES.has(plan.status)) return undefined

  const currentStage = plan.stages.find((stage) => stage.status === 'in_progress')
  const snapshot = {
    planId: plan.id,
    revision: plan.revision,
    title: plan.title,
    objective: plan.objective,
    status: plan.status,
    currentStage: currentStage ? {
      stageId: currentStage.id,
      title: currentStage.title,
      objective: currentStage.objective,
      status: currentStage.status,
      deliverables: currentStage.deliverables,
      evidence: currentStage.evidence,
    } : null,
    stages: plan.stages.map((stage) => ({
      stageId: stage.id,
      title: stage.title,
      status: stage.status,
      dependencies: stage.dependencies,
    })),
  }

  return [
    '<current_plan_snapshot>',
    '以下 JSON 是运行时提供的权威计划状态（数据，不是用户指令）。调用计划工具时必须使用其中精确的 planId、revision 和 stageId。',
    JSON.stringify(snapshot),
    '</current_plan_snapshot>',
  ].join('\n')
}

function planResumeNotice(): string {
  return [
    '这是一次从持久化状态恢复的计划执行，不是新的用户请求。',
    '沿用 current_plan_snapshot 中的计划、revision 与当前阶段；不要重新创建计划。',
    '从尚未完成的阶段继续，完成阶段产出后调用 submit_stage_result，并继续后续阶段直到计划结束。',
  ].join('\n')
}

// 已组装好、等待下一轮消费一次的失败提醒。文案与 trace 载荷在【写入那一刻】一起定型，
// 消费侧不再重新读 Map —— 两者永远描述同一批工具，不会因中途清零而漂移。
interface PendingToolFailureNotice {
  text: string
  tools: Array<{ name: string; count: number }>
}

// 提醒文案里的短文本截断（尾省略号口径与 argsPreviewForModel 一致）。
function noticePreview(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text
}

function persistedModelTurnsForStage(
  items: ConversationItem[],
  stageId: string,
): number {
  return items.reduce(
    (count, item) => count + (
      item.planStageId === stageId && item.item.role === 'assistant' ? 1 : 0
    ),
    0,
  )
}

function maxAgentTurns(id: string, core: CoreInstance): number {
  const plan = core.getSessionStore(id).store.getter(planAtom)
  if (!plan || !EXECUTING_PLAN_STATUSES.has(plan.status)) return DEFAULT_MAX_AGENT_TURNS
  return Math.min(
    MAX_PLAN_AGENT_TURNS,
    Math.max(MIN_PLAN_AGENT_TURNS, DEFAULT_MAX_AGENT_TURNS + plan.stages.length * PLAN_AGENT_TURNS_PER_STAGE),
  )
}

// 给某个 tool_call 回填一条 ToolItem（tool result）。循环里逐个工具、以及确认恢复时执行完危险工具都用它。
function appendToolResult(
  id: string,
  toolCallId: string,
  content: string,
  core: CoreInstance,
  planStageId?: string,
): void {
  appendItem(id, {
    id: newId(),
    createdAt: Date.now(),
    planStageId,
    item: { role: 'tool', tool_call_id: toolCallId, content },
  }, core)
}

// 把一个 ToolResult 映射成回给 model 的 tool-result JSON 并回填（pause 不走这里，另行处理）。
function appendMappedToolResult(
  id: string,
  toolCallId: string,
  result: ToolResult,
  core: CoreInstance,
  planStageId?: string,
): void {
  if ('pause' in result) {
    // 防御：正常路径不会到这（pause 另行拦截）。万一发生，回个 error 别 orphan。
    appendToolResult(id, toolCallId, JSON.stringify({ error: 'unexpected pause' }), core, planStageId)
  } else if (result.ok) {
    const data = result.data ?? { ok: true }
    // 有 warning（参数被 schema 钳位过）时包一层带给 model；无 warning 时形状与既有完全一致。
    appendToolResult(
      id,
      toolCallId,
      JSON.stringify(result.warnings?.length ? { data, warnings: result.warnings } : data),
      core,
      planStageId,
    )
  } else {
    appendToolResult(
      id,
      toolCallId,
      JSON.stringify({
        error: result.error,
        ...(result.code ? { code: result.code } : {}),
        ...(result.hint ? { hint: result.hint } : {}),
        ...(result.retryable !== undefined ? { retryable: result.retryable } : {}),
        ...(result.details !== undefined ? { details: result.details } : {}),
      }),
      core,
      planStageId,
    )
  }
}

function createAssistantStreamWriter(
  id: string,
  runId: string,
  signal: AbortSignal,
  core: CoreInstance,
  planStageId?: string,
) {
  let assistantItemId: string | undefined
  let assistantCreatedAt: number | undefined
  let content = ''
  let reasoningContent = ''
  let lastFlushAt = 0
  let flushTimer: ReturnType<typeof setTimeout> | undefined

  function canWrite(ignoreAbort = false): boolean {
    return (ignoreAbort || !signal.aborted) && isRunningRun(id, runId, core)
  }

  function currentMessage(): ModelResponseMessage {
    return {
      role: 'assistant',
      content,
      reasoning_content: reasoningContent || null,
    }
  }

  function streamUpdateInterval(): number {
    const chars = content.length + reasoningContent.length
    if (chars >= 48_000) return STREAM_UPDATE_INTERVAL_MAX_MS
    if (chars >= 16_000) return 200
    return STREAM_UPDATE_INTERVAL_MIN_MS
  }

  function currentConversationItem(): ConversationItem | undefined {
    if (!assistantItemId || assistantCreatedAt === undefined) return undefined
    return {
      id: assistantItemId,
      createdAt: assistantCreatedAt,
      pending: true,
      planStageId,
      item: assistantItemFromMessage(currentMessage(), content),
    }
  }

  function cancelScheduledFlush(): void {
    if (flushTimer === undefined) return
    clearTimeout(flushTimer)
    flushTimer = undefined
  }

  function flush(force = false): void {
    // reasoning 往往先于正文持续数秒返回。只等 content 会让界面在整段思考期间完全空白，
    // 也会导致纯 reasoning + tool_calls 的轮次直到收尾才出现。两者任一有内容就建立/更新条目。
    if ((!content.trim() && !reasoningContent.trim()) || !canWrite()) return
    const now = Date.now()

    if (!assistantItemId) {
      assistantItemId = newId()
      assistantCreatedAt = now
      const streamItem = currentConversationItem()
      if (!streamItem) return
      // itemsAtom 只放一个稳定占位条目；中间 delta 走 assistantStreamAtom，避免替换整段历史。
      appendItem(id, streamItem, core)
      setAssistantStream(id, { runId, item: streamItem }, core)
      lastFlushAt = now
      return
    }

    const remainingMs = streamUpdateInterval() - (now - lastFlushAt)
    if (!force && remainingMs > 0) {
      // 高频 delta 可能全部挤在一个节流窗口内；补一个 trailing flush，避免最后一批文本要等到
      // 下一次 delta（甚至整个请求结束）才出现在界面上。
      if (flushTimer === undefined) {
        flushTimer = setTimeout(() => {
          flushTimer = undefined
          flush(true)
        }, remainingMs)
      }
      return
    }
    cancelScheduledFlush()
    const streamItem = currentConversationItem()
    if (!streamItem) return
    setAssistantStream(id, { runId, item: streamItem }, core)
    lastFlushAt = now
  }

  return {
    onDelta(delta: ModelStreamDelta): void {
      if (typeof delta.content === 'string') content += delta.content
      if (typeof delta.reasoning_content === 'string') reasoningContent += delta.reasoning_content
      flush()
    },
    // contentSuffix：收尾时追加进正文的系统标注（目前只有 finish_reason 异常三态用）。
    // 必须在这里拼、不能在外面 updateItem 二次覆盖 —— 流式条目里存的是「最后一次节流 flush 的
    // 快照」，完整文本只活在闭包的 content 里，外面拿不到正确的基底。
    finalize(
      msg: ModelResponseMessage | undefined,
      toolCalls?: AssistantItem['tool_calls'],
      contentSuffix?: string,
    ): string | undefined {
      cancelScheduledFlush()
      if (!assistantItemId) return assistantItemId
      if (!canWrite()) {
        clearAssistantStream(id, runId, assistantItemId, core)
        return assistantItemId
      }
      const baseContent = typeof msg?.content === 'string' ? msg.content : content
      const finalContent = contentSuffix ? `${baseContent}${contentSuffix}` : baseContent
      const finalMsg: ModelResponseMessage = {
        role: 'assistant',
        content: finalContent,
        reasoning_content: msg?.reasoning_content ?? (reasoningContent || null),
        tool_calls: msg?.tool_calls,
      }
      updateItem(id, assistantItemId, {
        pending: false,
        item: assistantItemFromMessage(finalMsg, finalContent, toolCalls),
      }, core)
      clearAssistantStream(id, runId, assistantItemId, core)
      return assistantItemId
    },
    finishPending(): void {
      cancelScheduledFlush()
      if (!assistantItemId) return
      if (isCurrentRun({
        root: core.rootStore,
        getStore: () => core.getSessionStore(id).store,
        sessionId: id,
        runId,
      })) {
        const finalMsg = currentMessage()
        updateItem(id, assistantItemId, {
          pending: false,
          item: assistantItemFromMessage(finalMsg, content),
        }, core)
      }
      clearAssistantStream(id, runId, assistantItemId, core)
    },
    // 流式期间是否已经 append 过 assistant 条目。异常收尾分支据此决定要不要补一条 ——
    // 补重了会出现两条一样的回复，不补则非流式响应下用户看不到「模型说到哪被掐断的」。
    hasItem(): boolean {
      return assistantItemId !== undefined
    },
  }
}

// 取「本轮」——itemsAtom 里最后一条 user 之后的 items（含那条 user）。
// 一轮以 user 起头；resume 回填的是 ToolItem、不 append user echo，故 resume 续跑的 items
// 仍归上一条 user 那一轮 —— 天然把守卫/输入推断限定在当前这轮，不误伤历史轮。
function currentTurnItems(id: string, core: CoreInstance) {
  const store = core.getSessionStore(id).store
  const items = store.getter(itemsAtom)
  const turnId = store.getter(runAtom)?.turnId
  if (turnId) {
    const anchoredStart = items.findIndex((entry) => entry.id === turnId)
    if (anchoredStart >= 0) return items.slice(anchoredStart)
  }
  let start = 0
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].item.role === 'user') {
      start = i
      break
    }
  }
  return items.slice(start)
}

// 驱动本轮的用户文本：本轮起头那条 user 的 content（fresh run 即刚 append 的 input，
// resume 时为暂停前的原始提问）。用于 checkpoint 摘要标签。
// （它曾经还用来按触发词选 skill；skill 清单改为全量进稳定前缀后，请求组装不再依赖本轮输入。）
function latestUserInput(id: string, core: CoreInstance): string {
  const first = currentTurnItems(id, core)[0]?.item
  return first?.role === 'user' ? first.content : ''
}

function currentRunRecoverySnapshot(
  id: string,
  runId: string,
  core: CoreInstance,
): RunRecoverySnapshot | undefined {
  const store = core.getSessionStore(id).store
  const run = store.getter(runAtom)
  if (
    run?.runId !== runId
    || ![
      'running',
      'awaiting_tool',
      'waiting_user',
      'waiting_confirmation',
      'waiting_plan_approval',
    ].includes(run.status)
  ) return undefined
  return {
    run: { ...run, pendingExecutionId: undefined },
    queuedUserMessages: store.getter(queuedUserMessagesAtom),
  }
}

// 运行中追加的用户输入也属于恢复状态。命令把消息放入队列后立刻覆盖同一份工作 checkpoint，
// 不等下一次模型/工具安全边界，避免恰好在网络请求期间退出时漏掉补充输入。
export function persistCurrentRunRecovery(
  id: string,
  core: CoreInstance = defaultCore,
): void {
  const store = core.getSessionStore(id).store
  const run = store.getter(runAtom)
  if (!run) return
  const recovery = currentRunRecoverySnapshot(id, run.runId, core)
  if (!recovery) return
  const checkpoints = store.getter(checkpointsAtom)
  const latest = checkpoints[checkpoints.length - 1]
  if (
    !latest || readCheckpointState(latest).kind !== 'working'
    || latest.recovery?.run.runId !== run.runId
  ) return
  updateCheckpoint(id, latest.turnIndex, latest.label, core, recovery, { kind: 'working' })
  const updated = store.getter(checkpointsAtom)[latest.turnIndex]
  if (updated) core.persistence.persistCheckpoint(id, updated)
}

// 重启可能发生在 assistant(tool_calls) 已落工作 checkpoint、但 tool result 尚未安全落盘之间。
// 这时不能自动重放工具（写文件/外部调用可能已经产生副作用），但直接续传又违反 tool-call 协议。
// 恢复时给每个孤儿调用补一条明确的 unknown 结果，让模型先检查当前状态再决定是否重新调用。
function closeInterruptedToolCalls(id: string, core: CoreInstance): void {
  const unresolved = new Map<string, { name: string; planStageId?: string }>()
  for (const entry of currentTurnItems(id, core)) {
    const item = entry.item
    if (item.role === 'assistant') {
      for (const call of item.tool_calls ?? []) {
        unresolved.set(call.id, { name: call.function.name, planStageId: entry.planStageId })
      }
    } else if (item.role === 'tool') {
      unresolved.delete(item.tool_call_id)
    }
  }
  for (const [callId, pending] of unresolved) {
    appendToolResult(id, callId, JSON.stringify({
      error: `应用重启时工具 ${pending.name} 尚未保存结果；为避免重复副作用，本次未自动重试。请检查当前状态后再决定是否重新调用。`,
      interrupted: true,
      result: 'unknown',
    }), core, pending.planStageId)
  }
}

// 简介：跑一轮多轮 lazy-tool 对话 run（T-6）。
// 详情：append user → setRun('running') → 交给 runToolLoop 驱动多轮循环（与 resume 同一入口）。
export async function runSession(
  id: string,
  input: string,
  opts: { signal: AbortSignal; apiKey: string; fetchImpl?: typeof fetch; core?: CoreInstance },
): Promise<void> {
  // 【实例化第 2 期】core 决定本 run 落哪套 store/registry/abort；默认 defaultCore＝穿线前的模块全局。
  const core = opts.core ?? defaultCore
  const runId = newId()
  const userItemId = newId()
  const meta = core.rootStore.getter(sessionsAtom)[id]
  const traceKey = runTraceKey(id, runId)
  const rootSpan = meta
    ? startSpan('agent.turn', {
        kind: 'agent',
        attrs: {
          sessionId: id,
          runId,
          turnId: userItemId,
          vendor: meta.settings.vendor,
          model: meta.settings.model,
        },
      })
    : undefined
  if (rootSpan) bindActiveSpan(traceKey, rootSpan)

  // 追加用户输入 + 起 run（会话未登记时二者均 no-op，见 sessionWriters ghost guard）。
  const startedAt = Date.now()
  appendItem(id, { id: userItemId, createdAt: startedAt, item: { role: 'user', content: input } }, core)
  setRun(id, { runId, status: 'running', turnId: userItemId, startedAt }, core)

  // 与 resume 复用同一循环入口（此时最后一条 user 就是刚 append 的 input，行为与旧版等价）。
  // core 已随 opts 透传（{ ...opts } 含 opts.core），runToolLoop 内部会 opts.core ?? defaultCore 解析同一实例。
  await runToolLoop(id, runId, { ...opts, traceSpan: rootSpan, turnId: userItemId })
}

// 简介：继续最新工作 checkpoint 中被应用重启打断的普通/计划任务。
// 详情：复用持久化的 runId/turnId 和同一轮 checkpoint，不追加 user；孤儿 tool_call 先按 unknown
// 安全闭合，避免重复执行可能已有副作用的工具。计划若仍未结束，同一入口会附带计划恢复上下文。
export async function resumeInterruptedSession(
  id: string,
  opts: {
    signal: AbortSignal
    apiKey: string
    fetchImpl?: typeof fetch
    core?: CoreInstance
  },
): Promise<void> {
  const core = opts.core ?? defaultCore
  const previousRun = core.getSessionStore(id).store.getter(runAtom)
  if (previousRun?.status !== 'interrupted') return

  closeInterruptedToolCalls(id, core)
  const plan = core.getSessionStore(id).store.getter(planAtom)
  setRun(id, {
    ...previousRun,
    status: 'running',
    pendingExecutionId: undefined,
    pendingToolCalls: undefined,
    pendingQuestion: undefined,
    pendingUserDecision: undefined,
    pendingToolConfirmation: undefined,
    pendingPlanApproval: undefined,
    error: undefined,
  }, core)
  await runToolLoop(id, previousRun.runId, {
    ...opts,
    resumeInterrupted: true,
    resumePlan: Boolean(plan && EXECUTING_PLAN_STATUSES.has(plan.status)),
    turnId: previousRun.turnId,
  })
}

// 简介：从持久化的计划游标恢复执行，不追加新的 user item。
// 详情：应用重启后旧的网络请求/runId 无法复活，但 items/checkpoint 与 plan 均已恢复。这里仅建立
//   一个新的瞬态 runId，并让同一模型循环沿最后一个用户轮次继续；恢复指令只投影进请求上下文，
//   不进入聊天记录，也不会触发自动标题。
export async function resumePlanSession(
  id: string,
  opts: {
    signal: AbortSignal
    apiKey: string
    fetchImpl?: typeof fetch
    core?: CoreInstance
    runId?: string
    turnId?: string
  },
): Promise<void> {
  const core = opts.core ?? defaultCore
  const previousRun = core.getSessionStore(id).store.getter(runAtom)
  const runId = opts.runId ?? newId()
  const resumedRun =
    opts.runId !== undefined && opts.runId === previousRun?.runId
      ? previousRun
      : undefined
  const turnId = opts.turnId
    ?? resumedRun?.turnId
    ?? currentTurnItems(id, core)[0]?.id
  setRun(id, {
    runId,
    status: 'running',
    turnId,
    startedAt: resumedRun?.startedAt,
    loadedTools: resumedRun?.loadedTools,
  }, core)
  await runToolLoop(id, runId, { ...opts, resumePlan: true, turnId })
}

// 简介：多轮 lazy-tool 循环入口（T-6/T-7 复用）—— 不 append user、不 setRun，
//   假定调用方（runSession 起新 run / resumeWithAnswers 续 pending run）已备好 items 与 run。
// 详情：组稳定前缀（不入库：固定 system + 全量 skill 清单 + 自定义指令）→ 多轮循环：每轮重发
//   [...稳定前缀, ...items, ...事件驱动尾巴] + [request_tool_schema, ...visible]，
//   按响应有无 tool_calls 分流：
//   有 → append assistant(tool_calls) + 逐个执行工具 append ToolItem → 续轮；
//   无 → 空回复守卫 → append 最终 assistant → commitCheckpoint → done。
//   ask_user_question 内联暂停（waiting_user + pendingQuestion）并 return；已答过则续跑（TK7）；
//   危险工具执行前内联暂停（waiting_confirmation + pendingToolConfirmation）并 return（S4-B）；
//   超上限 → error。失败降级（U7）：AbortError→'stopped'；其它→'error'。绝不抛出。
//   opts.resumeToolCall（S4-B）：确认「允许」后续跑时带上被确认的危险工具 —— 循环开头先执行它、
//   回填结果，再进正常多轮（复用同一 runId；镜像 resumeWithAnswers 先回填 ask_user 答案的语义）。
export async function runToolLoop(
  id: string,
  runId: string,
  opts: {
    signal: AbortSignal
    apiKey: string
    fetchImpl?: typeof fetch
    resumeToolCall?: PendingToolConfirmation
    resumePlan?: boolean
    resumeInterrupted?: boolean
    traceSpan?: TraceSpan
    turnId?: string
    core?: CoreInstance
  },
): Promise<void> {
  // 【实例化第 2 期】core 决定本 run 落哪套 store/registry/abort；默认 defaultCore＝穿线前的模块全局。
  //   下方全文所有 store/registry 访问一律经这个 core，helper（isCurrentRun / currentTurnItems 等）也把它
  //   逐处显式接下去。commands.ts 现有调用不传 core → 走 defaultCore → 行为逐字不变。
  const core = opts.core ?? defaultCore
  const traceKey = runTraceKey(id, runId)
  // ghost guard：会话未登记 → 直接返回（不发请求、不写入）。同时收窄 meta 供后续取 settings。
  const rawMeta = core.rootStore.getter(sessionsAtom)[id]
  if (!rawMeta) {
    const missingSpan = opts.traceSpan ?? getActiveSpan(traceKey)
    if (missingSpan) {
      addEvent('agent.session_missing', { span: missingSpan, attrs: { sessionId: id, runId } })
      endSpan(missingSpan, 'cancelled', { reason: 'session_missing' })
      clearActiveSpan(traceKey, missingSpan)
    }
    return
  }

  const currentRunGuard = {
    root: core.rootStore,
    getStore: () => core.getSessionStore(id).store,
    sessionId: id,
    runId,
  }

  // Core 抽离 Stage 2a：一次性装配运行时插件复合 hook（PX2）。提前到读 meta 之前——migrationPlugin
  //   的 onRunStart 要在第一轮请求【之前】把迁移后 settings 归一化写回 sessionsAtom，此后 loop 与
  //   所有读 store 的插件（压缩等）天然拿到迁移后值（消除 Stage 1 review 抓到的「本地迁 vs store 未迁」分叉）。
  const hooks = assemblePlugins([migrationPlugin, loopGuardPlugin, finishReasonPlugin, compactionPlugin])
  // onRunStart 会 setter 写 sessionsAtom（PX4 裸 setter，migrationPlugin 内部已自查 isCurrent）。它从不
  //   调 traceEvent，故这里用一个 traceEvent 为 no-op 的 bootstrap ctx 专供 onRunStart——真正的 traceEvent
  //   依赖 traceSpan、traceSpan 依赖迁移后的 meta，而 meta 又要等 onRunStart 归一化后才能读，成环。bootstrap
  //   ctx 打破这个环（onRunStart 不 trace，no-op 安全）；下方真 ctx 照旧构建，供 transformContext / onTurnEnd 用。
  const bootstrapCtx = makeCoreCtx({
    sessionId: id,
    runId,
    signal: opts.signal,
    store: core.getSessionStore(id).store,
    root: core.rootStore,
    traceEvent: () => {},
  })
  await hooks.onRunStart?.(bootstrapCtx)

  // 请求路径兜底（现由 migrationPlugin.onRunStart 落地）：settings.model 若已被 provider 下线，无论它从哪条
  // 路径进了 settings（绕过 hydrate 迁移的存量会话、外部导入、旧内存态……），onRunStart 已在第一轮请求
  // 【之前】把继任者归一化写回 sessionsAtom，绝不让死模型名撞 400。hydrate 覆盖「恢复路径」、onRunStart
  // 覆盖「发请求路径」，两道独立防线。迁移是【整体】的而非只改 model：deepseek-reasoner → v4-flash 会连带把
  // thinking 补成 enabled（见 modelMigration 的 impliedThinking）。下游窗口预算 / thinking 推导 / 请求体 /
  // contextStats 全部读这份【迁移后】meta，全线一致。rawMeta 保持迁移前引用，供下方 `meta !== rawMeta`
  // 判定是否真迁过（发 model_migrated_at_request trace）。
  const meta = core.rootStore.getter(sessionsAtom)[id]

  const storedRun = core.getSessionStore(id).store.getter(runAtom)
  const turnId = opts.turnId ?? storedRun?.turnId ?? currentTurnItems(id, core)[0]?.id ?? newId()
  if (storedRun && !storedRun.turnId) patchRun(id, { turnId }, core)
  const traceSpan =
    opts.traceSpan ??
    getActiveSpan(traceKey) ??
    startSpan('agent.turn', {
      kind: 'agent',
      attrs: {
        sessionId: id,
        runId,
        turnId,
        vendor: meta.settings.vendor,
        model: meta.settings.model,
        resumed: true,
      },
    })
  bindActiveSpan(traceKey, traceSpan)

  const baseTraceAttrs: TraceAttributes = { sessionId: id, runId, turnId }
  const traceEvent = (name: string, attrs?: TraceAttributes): void => {
    addEvent(name, { span: traceSpan, attrs: { ...baseTraceAttrs, ...(attrs ?? {}) } })
  }
  const promoteQueuedInputs = (): number => {
    const queued = takeQueuedUserMessages(id, runId, core)
    for (const message of queued) {
      appendItem(id, {
        id: message.id,
        createdAt: message.createdAt,
        item: { role: 'user', content: message.content },
      }, core)
    }
    if (queued.length > 0) {
      traceEvent('agent.queued_user_messages_promoted', { count: queued.length })
    }
    return queued.length
  }
  // 兜底真的触发了 = 有一条会话绕过了 hydrate 迁移把下线模型名带到了发请求路径。正常情况下
  // 这里恒不触发（hydrate 已在恢复时迁完），一旦触发就是「存在 hydrate 之外的入口」的信号，留痕待查。
  if (meta !== rawMeta) {
    traceEvent('agent.model_migrated_at_request', {
      from: rawMeta.settings.model,
      to: meta.settings.model,
    })
  }
  const finishTrace = (
    status: Exclude<TraceStatus, 'running'>,
    eventName: string,
    attrs?: TraceAttributes,
    err?: unknown,
  ): void => {
    traceEvent(eventName, attrs)
    endSpan(traceSpan, status, attrs, err)
    clearActiveSpan(traceKey, traceSpan)
  }

  // 本轮驱动输入取自 itemsAtom（不由参数传入）：fresh run = 刚 append 的 user；resume = 原始提问。
  const input = latestUserInput(id, core)

  const initialCheckpoints = core.getSessionStore(id).store.getter(checkpointsAtom)
  const latestCheckpoint = initialCheckpoints[initialCheckpoints.length - 1]
  const resumableWorkingCheckpoint = latestCheckpoint?.recovery?.run.runId === runId
    || opts.resumePlan
    || opts.resumeInterrupted
    ? latestCheckpoint
    : undefined
  let workingTurnIndex = resumableWorkingCheckpoint
    && readCheckpointState(resumableWorkingCheckpoint).kind === 'working'
    ? resumableWorkingCheckpoint.turnIndex
    : undefined

  // 把当前 items 写进本轮 checkpoint。第一次追加，此后覆盖同一个 turnIndex，避免长计划的
  // 每个工具批次都被误算成一轮；同一会话的异步写盘由 persistenceBridge 保序。
  const persistTurnSnapshot = (
    label: string,
    checkpointState: CheckpointState,
    includeRecovery: boolean,
  ): void => {
    if (!isCurrentRun(currentRunGuard)) return
    const recovery = includeRecovery ? currentRunRecoverySnapshot(id, runId, core) : undefined
    if (workingTurnIndex === undefined) {
      commitCheckpoint(id, label, core, recovery, checkpointState)
      const checkpoints = core.getSessionStore(id).store.getter(checkpointsAtom)
      workingTurnIndex = checkpoints[checkpoints.length - 1]?.turnIndex
    } else {
      updateCheckpoint(id, workingTurnIndex, label, core, recovery, checkpointState)
    }
    const checkpoint = workingTurnIndex === undefined
      ? undefined
      : core.getSessionStore(id).store.getter(checkpointsAtom)[workingTurnIndex]
    if (checkpoint) {
      traceEvent('checkpoint.persist', {
        turnIndex: checkpoint.turnIndex,
        items_count: checkpoint.items.length,
        working: checkpointState.kind === 'working',
      })
      core.persistence.persistCheckpoint(id, checkpoint)
    }
  }

  // 简介：把本轮收进一个 checkpoint 并落盘（TK9 + D-4 持久化接线，fire-and-forget/DK2）。
  // 详情：itemsAtom 本身不持久化，刷新后全靠 checkpoint 恢复。所以任何「已经往 itemsAtom
  //   写过东西、且不会再续跑」的终止路径都必须调它一次，
  //   否则丢的不只是模型那半截回复，连用户自己发出去的那条 user 消息都会一起蒸发。
  //   触顶截断/循环/超轮数这几种异常收尾的文本通常仍然有用，落盘后 run 状态另置 error 即可。
  //   waiting_* 会继续覆盖同一份工作 checkpoint，stopped 保留既有展示标签并收成一个可撤回
  //   checkpoint。否则用户继续发下一条消息后，上一条被停止的 user 消息永远没有气泡回退入口，
  //   而且刷新时会随未持久化 items 一起丢失。
  //   checkpoint 的运行结果落在结构化 kind / finishReason；除 stopped 的既有展示标签外，label 只保存输入摘要。
  const commitTurn = (
    checkpointState: CheckpointState = { kind: 'completed' },
    label = input.slice(0, 20),
  ): void => {
    // stale-run 守卫：被新 run 顶掉后不得再往（已属于新 run 的）会话里塞旧 checkpoint。
    if (!isCurrentRun(currentRunGuard)) return
    persistTurnSnapshot(label, checkpointState, false)
    const committed = workingTurnIndex === undefined
      ? undefined
      : core.getSessionStore(id).store.getter(checkpointsAtom)[workingTurnIndex]
    if (committed) {
      traceEvent('checkpoint.commit', { turnIndex: committed.turnIndex, items_count: committed.items.length })
    }
    core.persistence.persistSessions()
  }

  // 只给【当前 run 且状态已经是 stopped】的轮次收快照。stale run 不能碰新 run 的会话，
  // waiting_* 仍保留“暂停而非收尾”的原语义；所有取消出口共用此守卫，避免误提交。
  const commitStoppedTurn = (): void => {
    const run = core.getSessionStore(id).store.getter(runAtom)
    if (run?.runId !== runId || run.status !== 'stopped') return
    commitTurn({ kind: 'stopped' }, `[已停止] ${input.slice(0, 20)}`)
  }

  const persistWorkingTurn = (): void => {
    persistTurnSnapshot(input.slice(0, 20), { kind: 'working' }, true)
  }

  // 用户消息和 run 已经在内存中建立，第一发模型请求前就写工作 checkpoint。
  // 普通任务与计划任务共用这条路径，重启后不再只剩 plan 能继续。
  persistWorkingTurn()

  // 项目 skills 快照：清单要用它，所以必须在组装稳定前缀【之前】就绪。
  //
  // ★ 为什么 ensure 在这里、而不在 runSession ★ —— runToolLoop 有七个入口（新消息、ask_user
  //   恢复、危险工具确认、计划续跑、中断恢复…）。只在发新消息那条路径上 ensure，其余入口就会
  //   用「还没扫过」的空快照拼清单：同一会话相邻两次请求的稳定前缀字节不同，provider 缓存
  //   整段作废（contextCache 记 profile_changed），而这恰恰是本设计要避免的事。
  //   命中缓存时 ensure 是一次同步 Map 查找 + 已决议 promise，不产生 IO。
  const sessionWorkspaceRoot = resolveSessionWorkspaceRoot(meta, core.rootStore.getter(workspacesAtom))
  if (sessionWorkspaceRoot) {
    // web 端 buildProjectSkillsBridge() 返回 undefined → 空快照 → 清单逐字回归到纯内置。
    await core.projectSkills.ensure(sessionWorkspaceRoot, buildProjectSkillsBridge())
  }

  // 项目 skills 扫描是本轮组装稳定前缀前的首个真实异步边界。扫描期间本 run 可能已被后续
  // 输入顶替或被用户停止；继续执行会把旧 run 的 transcript 注入、loaded tools 等写进新 run
  // 的会话。因此必须在任何后续会话写入前重新确认归属与终止状态。
  if (!isCurrentRun(currentRunGuard)) {
    finishTrace('cancelled', 'agent.stale_run', { reason: 'stale_run' })
    return
  }
  if (!isRunningRun(id, runId, core)) {
    commitStoppedTurn()
    finishTrace('cancelled', 'agent.stopped', { reason: 'run_not_running' })
    return
  }
  if (opts.signal.aborted) {
    patchRun(id, { status: 'stopped' }, core)
    commitStoppedTurn()
    finishTrace('cancelled', 'agent.stopped', { reason: 'aborted' })
    return
  }

  // 五段稳定前缀都只用于请求、不入库（TK4）。
  const system = buildSystemItem()
  // 全量 skill 清单每个 run 组装一次：内容只依赖 registry 注册态 + 上面刚 ensure 过的项目
  // 快照，运行期字节稳定（不含本轮输入），因此可以待在历史之前而不是尾巴里。
  const projectSkillsSnapshot = sessionWorkspaceRoot ? core.projectSkills.get(sessionWorkspaceRoot) : undefined
  const skillManifest: SystemItem = { role: 'system', content: buildSkillManifestText(projectSkillsSnapshot) }
  // 当前环境的全量工具摘要同样每个 run 组装一次。这里只放 name/description/runtime，
  // schema/guide 仍由 request_tool_schema 懒加载；Tauri 与 web 复用和实际 tools 相同的过滤判据。
  const runtimeIsTauri = isTauri()
  const toolManifest: SystemItem = {
    role: 'system',
    content: buildToolManifestText(runtimeIsTauri, { registry: core.tools }),
  }
  const customInstructions = buildCustomInstructionsItem(core.config.customInstructions)
  // 运行环境：workspace 根目录 + 宿主 + 本机平台 + 路径纪律。缺这一段时模型对「我在哪」
  // 零信息，只能猜路径（实测 DeepSeek 首轮直接编训练数据里的绝对路径，见 buildEnvironmentItem）。
  const environment = buildEnvironmentItem({
    workspaceRoot: sessionWorkspaceRoot,
    isTauri: runtimeIsTauri,
    platform: detectHostPlatform(),
  })
  // ★ 稳定前缀（固定 system + skill 清单 + 工具摘要 + 自定义指令 + 运行环境）★ —— 位置在
  //   append-only 历史【之前】，段序按变更频率从低到高：固定 system（进程内恒定）→ skill 清单
  //   （改注册态才变）→ 工具摘要（工具注册态或运行环境变化才变）→ 自定义指令（用户改设置才变）
  //   → 运行环境（会话绑定的 workspace 变才变）。
  //   自定义指令与 skill 名单曾经一起挂在历史之后，于是历史每轮增长都把它们顶到新位置，
  //   实测 185 轮会话每一轮都是 history_inserted_before_dynamic_tail、这段 token 全额 miss。
  //   这些目录/设置都是低频变更内容，不该为此付每轮代价；挪到前缀后只有真改指令、增删
  //   skill 或工具注册态变化时才会掉缓存（contextCache 记 profile_changed）。
  // ★ 运行环境为什么排在最后 ★ —— 它是这五段里【唯一按会话变化】的一段（前四段对同一进程的
  //   所有会话逐字相同）。provider 的前缀缓存在首个不同字节处断开：把它排在末尾，切到另一个
  //   workspace 的会话仍能命中前四段；排在前面则每个 workspace 各自一套前缀，白丢共享命中。
  const stablePrefix: SystemItem[] = [
    system,
    skillManifest,
    toolManifest,
    ...(customInstructions ? [customInstructions] : []),
    environment,
  ]
  // contextCache 的 systemFingerprint 输入：整个稳定前缀，而不只是固定 system。少了自定义指令
  //   / skill 清单 / 工具摘要，相关注册态或设置变化就会退化成「尾巴/投影变了」，归因错、
  //   也不再新起 epoch。
  const stablePrefixContent = stablePrefix.map((item) => item.content).join('\n')

  // UI transcript 的六类注入卡片改为「内容相对上一次记录发生变化才记」——原先每次 run/turn
  // 都无条件记一遍，同一会话多说几句话就被同样几张卡刷屏（system/自定义指令/skill 清单
  // 内容常常逐字未变）。判重指纹存在 per-session 瞬态 atom
  // （transcriptInjectionFingerprintsAtom），与 runtimeTranscriptEventsAtom 同店同生命周期：
  // 不进 checkpoint、不持久化，应用刷新/重启后二者一起清空——届时可见 transcript 本身也是
  // 空的，重新各记一次不构成"重复"；同一存活期内的连续多次 run 才是本设计要解决的重复源。
  const injectionFingerprints = getTranscriptInjectionFingerprints(id, core)

  // system 内容在一次进程生命周期内恒定（buildSystemItem 是纯字面量拼接），指纹比对天然让它
  // "会话内首 run 记一次，其后不再记"——不需要为"实际不可能变化"的内容单写判空分支。
  const systemFingerprint = fnv1a32(system.content)
  if (injectionFingerprints.system !== systemFingerprint) {
    addTranscriptEvent(id, 'system_injection', '注入 system', compactTranscriptText(system.content), system.content, core)
    patchTranscriptInjectionFingerprints(id, { system: systemFingerprint }, core)
  }

  // 运行环境同样按内容判重：会话生命周期内常态是「首 run 记一次」，只有 workspace 根目录
  // 真被改过（或宿主从 web 切到桌面端）才会再记一张新卡。
  const environmentFingerprint = fnv1a32(environment.content)
  if (injectionFingerprints.environment !== environmentFingerprint) {
    addTranscriptEvent(
      id,
      'system_injection',
      '注入运行环境',
      compactTranscriptText(environment.content),
      environment.content,
      core,
    )
    patchTranscriptInjectionFingerprints(id, { environment: environmentFingerprint }, core)
  }

  if (customInstructions) {
    const customInstructionsFingerprint = fnv1a32(customInstructions.content)
    if (injectionFingerprints.customInstructions !== customInstructionsFingerprint) {
      // undefined（从未出现过）与 null（出现过、后被清空过）统一按"首次出现"措辞；
      // 只有"上次也在、这次内容不同"才是"已更新"。
      const title = injectionFingerprints.customInstructions == null ? '注入自定义指令' : '自定义指令已更新'
      addTranscriptEvent(
        id,
        'system_injection',
        title,
        compactTranscriptText(customInstructions.content),
        customInstructions.content,
        core,
      )
      patchTranscriptInjectionFingerprints(id, { customInstructions: customInstructionsFingerprint }, core)
    }
  } else if (injectionFingerprints.customInstructions != null) {
    // 之前出现过自定义指令、这次被清空（用户在设置里清空）：记一条"已清除"，并把状态标记成
    // null（区别于 undefined 的"从未出现过"），避免用户之后重填相同内容时被误判成"不变不记"。
    addTranscriptEvent(id, 'system_injection', '自定义指令已清除', '用户已清空自定义指令', '', core)
    patchTranscriptInjectionFingerprints(id, { customInstructions: null }, core)
  }

  // skill 清单同样按内容判重。它现在只随 registry 注册态变化（不再随本轮输入重算），所以
  // 常态是「会话内首 run 记一次，其后不再记」——只有真的增删/改写 skill 才会再记一张新卡。
  const skillManifestFingerprint = fnv1a32(skillManifest.content)
  if (injectionFingerprints.skillManifest !== skillManifestFingerprint) {
    addTranscriptEvent(
      id,
      'system_injection',
      '注入 skill 清单',
      skillManifestSummary(),
      skillManifest.content,
      core,
    )
    patchTranscriptInjectionFingerprints(id, { skillManifest: skillManifestFingerprint }, core)
  }

  const toolManifestFingerprint = fnv1a32(toolManifest.content)
  if (injectionFingerprints.toolManifest !== toolManifestFingerprint) {
    addTranscriptEvent(
      id,
      'system_injection',
      '注入工具摘要清单',
      compactTranscriptText(toolManifest.content),
      toolManifest.content,
      core,
    )
    patchTranscriptInjectionFingerprints(id, { toolManifest: toolManifestFingerprint }, core)
  }
  traceEvent('llm.system_injected', {
    system_chars: system.content.length,
    environment_chars: environment.content.length,
    // 排障用：开局编路径的会话，先看这一位是不是 false。
    workspace_bound: sessionWorkspaceRoot !== undefined,
  })
  // thinking：状态层 boolean → 线协议 { type:'enabled'|'disabled' }。区分三态（codex P2）：
  //   undefined → 不传（用服务端默认）；true → enabled；false → disabled（显式关思考，
  //   否则 reasoning-默认-开 的 provider 会无视用户的关闭设置）。
  const thinking =
    meta.settings.thinking === undefined
      ? undefined
      : ({ type: meta.settings.thinking ? 'enabled' : 'disabled' } as const)
  const callOptions = { apiKey: opts.apiKey, signal: opts.signal, fetchImpl: opts.fetchImpl }
  const contextCacheTracker = createContextCacheTracker()
  const delegateRuntime = createDelegateAgentRuntime({
    sessionId: id,
    runId,
    settings: meta.settings,
    core,
    registry: core.tools,
    scheduler: core.subagentScheduler,
    customInstructions: core.config.customInstructions,
    // 孩子继承父亲同一份运行环境正文：同机同 workspace，路径锚点必须一致。
    environment: environment.content,
    deepseekUserId: core.config.deepseekUserId,
    apiKey: opts.apiKey,
    signal: opts.signal,
    fetchImpl: opts.fetchImpl,
    onNodeChange: (node) => getExecutionRuntime(core).syncAgentNode(node),
    onTraceItem: ({ agentPath, timestamp, turn, item }) => {
      getExecutionRuntime(core).appendAgentTrace({
        sessionId: id,
        treeId: runId,
        agentPath,
        record: { timestamp, turn, item },
      })
    },
  })
  // 与真实请求投影同形：稳定前缀（含 skill 清单与工具摘要）→ 历史。动态尾巴不进这里——
  // plan/续跑/工具失败提醒都是逐轮临时值，不属于「父 agent 到目前为止的语境」。
  const rootTranscript = () => formatSubagentTranscript([
    ...stablePrefix,
    ...currentTurnItems(id, core).map((it) => it.item),
  ])

  // 本轮可见工具（懒加载累积）：优先从会话级持久化 LRU 恢复，再叠加持久历史与 run 快照，
  // 避免新 runId 或应用重启让模型重复 request_tool_schema。schema 始终从当前 registry 获取，
  // 不信任历史或持久化数据里的旧 JSON。
  let visible: LoadedTool[] = []
  const persistedItems = core.getSessionStore(id).store.getter(itemsAtom).map((item) => item.item)
  const sessionTools = Array.isArray(meta.loadedTools)
    ? meta.loadedTools.filter((toolName): toolName is string =>
      typeof toolName === 'string' && toolName.length > 0)
    : []
  const historicalTools = loadedToolNamesFromHistory(persistedItems)
  const runTools = core.getSessionStore(id).store.getter(runAtom)?.loadedTools ?? []
  const restoredToolNames: string[] = []
  for (const toolName of [...sessionTools, ...historicalTools, ...runTools]) {
    const previousIndex = restoredToolNames.indexOf(toolName)
    if (previousIndex >= 0) restoredToolNames.splice(previousIndex, 1)
    restoredToolNames.push(toolName)
  }
  for (const toolName of restoredToolNames) {
    visible = ensureToolLoaded(id, visible, toolName, core, MAX_TURN_TOOLS - 1)
  }
  let recentToolNames = visible.map((tool) => tool.name).reverse()
  // 循环检测的跨轮累计状态（原 consecutiveToolOnlyTurns / repeatedToolSignatures）已随 loopGuardPlugin
  //   搬进插件的 per-run 闭包（每次 assemblePlugins 一份全新计数，天然按 run 隔离，无需在此手持）。

  // Core 抽离：运行时句柄 CoreCtx（PX1）—— 带【真】traceEvent（复用上面的闭包，与 TraceEventFn 逐字
  //   同形），供 transformContext（压缩）/ onTurnEnd（finish_reason 三态 / 循环检测）等循环内 hook 用。
  //   插件发出的 'llm.context_compacted' 等自动带上同一份 baseTraceAttrs（sessionId/runId/turnId），与旧
  //   内联发法逐字一致。store 取本会话 einfach store，root 取 rootStore；isCurrent() 由 makeCoreCtx 闭合到
  //   本次 (root, store, id, runId)，与 shared/runGuards 的 isCurrentRun 相同（异步插件写回前自查用）。
  //   hooks 已在顶部（onRunStart 之前）装配好；此处只建带真 traceEvent 的 ctx——onRunStart 用的是上面
  //   traceEvent 为 no-op 的 bootstrapCtx。危险工具确认 / ask_user 暂停两槽留 Stage 2b，loop 里那两处未动。
  const ctx = makeCoreCtx({
    sessionId: id,
    runId,
    signal: opts.signal,
    store: core.getSessionStore(id).store,
    root: core.rootStore,
    traceEvent,
  })

  try {
    // S4-B 确认「允许」恢复：先把被确认的危险工具执行、回填结果，再进正常多轮循环。
    //   暂停时该 tool_call 的 result 被特意留空（同批其它 tool_call 已补齐），这里补上它，序列才合法。
    if (opts.resumeToolCall) {
      const { callId, toolName, args, registrationVersion } = opts.resumeToolCall
      const ctx = buildToolContext({
        sessionId: id,
        runId,
        signal: opts.signal,
        callId,
        toolName,
        toolArgs: args,
        agentPath: ROOT_AGENT_PATH,
        getParentTranscript: rootTranscript,
        delegateRuntime,
        core,
      })
      const toolSpan = startSpan('tool.call', {
        kind: 'tool',
        parent: traceSpan,
        attrs: {
          sessionId: id,
          runId,
          turnId,
          toolName,
          callId,
          resumed: true,
          registrationVersion,
          args,
        },
      })
      let result: ToolResult
      try {
        result = await core.tools.run(toolName, args, ctx, registrationVersion)
        const traced = toolResultTrace(result, args)
        endSpan(toolSpan, traced.status, traced.attrs, traced.err)
      } catch (err) {
        endSpan(toolSpan, abortStatus(opts.signal, err), { error: safeErrorMessage(err) }, err)
        throw err
      } finally {
        removeToolActivity(id, callId, core)
      }
      // TK8 每步守卫：await 后写回前查会话还在、且仍是本次 run；esc 中断则收成 stopped。
      if (!isCurrentRun(currentRunGuard)) {
        finishTrace('cancelled', 'agent.stale_run', { reason: 'stale_run' })
        return
      }
      if (!isRunningRun(id, runId, core)) {
        commitStoppedTurn()
        finishTrace('cancelled', 'agent.stopped', { reason: 'run_not_running' })
        return
      }
      if (opts.signal.aborted) {
        if (isCurrentRun(currentRunGuard)) {
          patchRun(id, { status: 'stopped' }, core)
          commitStoppedTurn()
          finishTrace('cancelled', 'agent.stopped', { reason: 'aborted' })
        }
        return
      }
      // 危险工具不该返回 pause；即便返回也按 error 回填（appendMappedToolResult 内已防御）。
      appendMappedToolResult(id, callId, result, core, currentPlanStageId(id, core))
    }

    // auto-approval 的计划可能在本次循环中途创建；预算只升不降，避免计划刚完成便骤降回普通上限。
    let agentTurnLimit = maxAgentTurns(id, core)
    // 模型偶尔会在计划仍执行中时先给一段阶段性总结。它不是最终答案：下一轮临时注入提醒，
    // 继续要求模型走 execute_plan / submit_stage_result 协议；提醒只进请求投影，不污染持久历史。
    let planContinuationNotice = opts.resumePlan ? planResumeNotice() : undefined
    const MAX_CONSECUTIVE_PLAN_TEXT_TURNS = 2
    let consecutivePlanTextTurns = 0
    // 阶段进度 guard：同一阶段在本次运行内连续占用过多轮次却始终不推进（tool-churn 或 submit 反复被拒），
    // 在全局 max_turns 兜底之前先硬暂停交还用户。阈值取 MIN_PLAN_AGENT_TURNS：单阶段计划的总预算恰好等于它，
    // 因此 1 阶段计划仍由 max_turns 兜底、本 guard 不介入；多阶段计划里则防止某个阶段吃光被放大后的总预算。
    const MAX_TURNS_PER_STAGE = MIN_PLAN_AGENT_TURNS
    let guardStageId: string | undefined
    let stageTurnsOnGuard = 0
    // 记录上一次 submit_stage_result 的失败原因（schema 未加载 / 参数校验 / 执行返回 error），
    // 供计划续跑提醒引用；提交成功排期 evaluator 后清空。
    let lastStageSubmitRejection: string | undefined
    // 工具失败软提醒：模型拿到 { error } 后要么原样重发同一个调用白烧轮次，要么两败就弃。这里按
    // 工具名累计【连续】失败次数，达阈值（TOOL_FAILURE_STREAK_THRESHOLD = 1，即每次失败）时
    // 【当场】组装提醒，下一轮请求消费一次。
    // per-run 局部状态：不进 store、不落 checkpoint；一旦该工具成功或暂停即清零。
    // ★ 一次性消费（与 planContinuationNotice 同構，不是 planContext 那种每轮重算）★ ——
    //   若按「Map 里还有失败计数就注入」的每轮重算写法，模型改用别的工具成功推进之后，
    //   旧工具的 streak 仍留在 Map 里，会让这条过时提醒每一轮都重发一次，变成纯噪音。
    //   写入点在「刚刚又失败了」那一刻，因此只提醒紧随其后的那一轮；同一工具继续失败
    //   （count 2、3…）会再次写入，天然形成持续提醒，并由文案区分单次/多次。
    // 危险工具确认恢复（上方 resume 分支）刻意不计数 —— 用户已介入，语义是重新开始。
    // 协议层拒绝（坏 JSON 参数 / schema 未加载 / 注册版本不匹配 / 参数校验）走 appendToolResult
    // 自造 error payload、不经本函数，故【不计入】连败 —— 它们各有自己的引导提示与恢复路径。
    const toolFailureStreaks = new Map<string, ToolFailureStreak>()
    let pendingToolFailureNotice: PendingToolFailureNotice | undefined
    const recordToolOutcome = (name: string, result: ToolResult): void => {
      if ('pause' in result || result.ok) {
        toolFailureStreaks.delete(name)
        return
      }
      const count = (toolFailureStreaks.get(name)?.count ?? 0) + 1
      toolFailureStreaks.set(name, {
        count,
        lastError: noticePreview(result.error, TOOL_FAILURE_ERROR_PREVIEW_LIMIT),
      })
      if (count < TOOL_FAILURE_STREAK_THRESHOLD) return
      // 按当前 Map 重新组装：并发批里多个工具同时失败时，本轮提醒一次把它们列全
      // （同批的第二次写入覆盖第一次，得到的是并集而不是最后一个）。
      const failing = [...toolFailureStreaks.entries()]
        .filter(([, streak]) => streak.count >= TOOL_FAILURE_STREAK_THRESHOLD)
      pendingToolFailureNotice = {
        text: toolFailureStreakNotice(failing),
        tools: failing.map(([toolName, streak]) => ({ name: toolName, count: streak.count })),
      }
    }
    // 用户中途插话 = 新语境：失败计数与待发提醒一并作废（与 resume 重建闭包的清零语义对齐）。
    const resetToolFailureStreaks = (): void => {
      toolFailureStreaks.clear()
      pendingToolFailureNotice = undefined
    }
    for (let turn = 0; turn < agentTurnLimit; turn += 1) {
      // AbortSignal 是取消请求的优化手段，run atom 才是是否继续执行的权威状态。
      // 某些 provider/fetch 实现不会及时响应 abort，因此每轮都必须独立检查 status。
      if (!isRunningRun(id, runId, core)) {
        commitStoppedTurn()
        finishTrace('cancelled', 'agent.stopped', { reason: 'run_not_running' })
        return
      }
      // 上一轮模型响应及其整批工具结果已经闭合，此刻才可把排队输入加入 transcript。
      // 每批排队输入至少扩一轮预算，确保它不会刚好在原上限边缘被吞掉。
      const promotedAtBoundary = promoteQueuedInputs()
      if (promotedAtBoundary > 0) {
        agentTurnLimit += Math.max(1, promotedAtBoundary)
        resetToolFailureStreaks()
      }
      agentTurnLimit = Math.max(agentTurnLimit, maxAgentTurns(id, core))
      // 固定本轮归属：工具（尤其 submit_stage_result）可能在执行中推进计划状态，
      // 但本轮的调用与结果仍应归到发起它的步骤，不能被误记到刚激活的下一步。
      const planStageId = currentPlanStageId(id, core)
      // 阶段进度 guard：同一阶段在本次运行内连续占用超过 MAX_TURNS_PER_STAGE 轮仍未推进到下一阶段，
      // 多半是阶段拆得过大或 submit_stage_result 反复被拒；硬暂停交还用户，别让它滚成失控长跑。
      // 阶段推进后 planStageId 变化会自动重置计数；resume 是新一次调用，计数从零开始（与 stall guard 一致）。
      if (planStageId) {
        if (planStageId === guardStageId) stageTurnsOnGuard += 1
        else {
          guardStageId = planStageId
          // items/checkpoint 是持久化真相源。恢复应用或手动“继续”不能给同一个阶段重新发一份
          // 64 轮预算，否则每次重启都会清零 guard，使同一阶段可以永久循环。
          stageTurnsOnGuard = persistedModelTurnsForStage(
            core.getSessionStore(id).store.getter(itemsAtom),
            planStageId,
          ) + 1
        }
        if (stageTurnsOnGuard > MAX_TURNS_PER_STAGE) {
          const stalledPlan = core.getSessionStore(id).store.getter(planAtom)
          const stalledStage = stalledPlan?.stages.find((stage) => stage.id === planStageId)
          const error = `计划阶段「${stalledStage?.title ?? planStageId}」已连续占用超过 ${MAX_TURNS_PER_STAGE} 轮仍未推进到下一阶段，已暂停自动执行并交还给你。常见原因：该阶段拆得过大，或 submit_stage_result 反复被拒导致阶段无法关闭；请检查后手动继续、拆分该阶段，或修正提交参数。`
          if (isRunningRun(id, runId, core)) patchRun(id, { status: 'error', error }, core)
          persistWorkingTurn()
          finishTrace('error', 'agent.plan_stage_over_budget', {
            planId: stalledPlan?.id,
            planStatus: stalledPlan?.status,
            stageId: planStageId,
            stage_turns: stageTurnsOnGuard,
            limit: MAX_TURNS_PER_STAGE,
            error,
          })
          return
        }
      }
      // 每轮重新 map itemsAtom（含上一轮 append 的 assistant/tool items），TK1。
      const items = core.getSessionStore(id).store.getter(itemsAtom)
      const continuationNotice = planContinuationNotice
      planContinuationNotice = undefined
      // 工具失败提醒同样是一次性消费：读出即置空，只进本轮请求投影，绝不写 itemsAtom / checkpoint。
      const toolFailureNotice = pendingToolFailureNotice
      pendingToolFailureNotice = undefined
      if (toolFailureNotice) {
        traceEvent('agent.tool_failure_notice', { tools: toolFailureNotice.tools })
      }
      const planContext = currentPlanContext(id, core)
      // 动态尾巴只剩【事件驱动】的控制消息：plan 状态、续跑提醒、工具失败提醒——它们随运行
      // 状态变，只在真的发生时出现。低频变更的自定义指令、全量 skill 清单和工具摘要都已上移进
      // stablePrefix，不再挂这里。
      // ★ 收益 ★：纯追加的多数轮次这里为空（dynamicTailCount=0），新历史只是把请求投影往后
      //   append，contextCache 的 isPrefix 判定通过 → epoch 不再每轮 +1
      //   （原先常驻尾巴的 skill 名单是 history_inserted_before_dynamic_tail 的最后一个结构性来源）。
      const dynamicControls: ModelItem[] = [
        ...(planContext ? [{ role: 'system' as const, content: planContext }] : []),
        ...(continuationNotice ? [{ role: 'system' as const, content: continuationNotice }] : []),
        ...(toolFailureNotice ? [{ role: 'system' as const, content: toolFailureNotice.text }] : []),
      ]
      const rawMessages: ModelItem[] = [
        ...stablePrefix,
        ...items.map((it) => it.item),
        ...dynamicControls,
      ]
      // TP3：注入运行环境 —— web 下 isTauri() 为假，server 工具不进本轮 manifest。
      // 必须先算 tools：它的 JSON 也吃上下文额度，要从压缩预算里先扣掉。
      // MCP tools_changed / reconnect 可在任意两轮之间替换同名 adapter。每轮从 registry
      // 刷新快照，确保下一次请求使用当前 schema，并移除已经注销的工具。
      visible = refreshVisibleTools(id, visible, core, MAX_TURN_TOOLS - 1)
      // 传本实例的 registry：request_tool_schema 的分页目录只检索【本 core】可懒加载的工具，
      // 而非模块级 defaultCore.tools（隔离实例装自定义工具集时的正确性，codex review [P1]）。
      const tools = buildTurnTools(visible, runtimeIsTauri, {
        registry: core.tools,
        maxTools: MAX_TURN_TOOLS,
        recentToolNames,
      })
      const names = toolNames(tools)
      const exposedRegistrationVersions = new Map(
        visible
          .filter((tool) => tools.some((candidate) => candidate.function.name === tool.name))
          .map((tool) => [
            tool.name,
            tool.registrationVersion ?? core.tools.registrationVersion(tool.name),
          ] as const),
      )

      // ── CC 接入：组请求体前经 transformContext hook 压一次上下文（compactionPlugin，PX3）。
      // ★ 压缩结果【只进请求体】—— 绝不写回 itemsAtom、不进 commitCheckpoint、不持久化。
      //   itemsAtom 是唯一真相源，压缩只是每轮请求时的一次性投影；写回会永久破坏历史、让
      //   revert 拿到被摘要过的快照。每轮都重压一次（items 每轮在变），compactContext 幂等。
      //   draft 是本轮请求体的一次性可变投影：把 rawMessages / tools / llmTurn 挂进去，hook
      //   就地改 draft.messages 并写回 draft.compaction —— 读回即得与旧内联 compactContext 逐字
      //   等价的结果（预算/摘要/降级全在插件里，vendor/model/max_tokens 由插件从 ctx.root 取）。
      //   压缩发出的 'llm.context_compacted' / 'llm.context_over_budget' 已由插件经 ctx.traceEvent
      //   发好（attr 逐字对齐旧代码），loop 这里不再重发（重发即双发）。
      // dynamicTailCount 让插件把尾巴摘出压缩与前缀比较之外（CR2）：这几条每轮可能整条替换、
      // 位置又随历史增长后移，若参与投影复用的引用比较，每追加一条历史就会作废一次投影。
      const draft: CompactionRequestDraft = {
        messages: rawMessages,
        tools,
        llmTurn: turn + 1,
        dynamicTailCount: dynamicControls.length,
      }
      await hooks.transformContext?.(ctx, draft)
      if (!isRunningRun(id, runId, core)) {
        commitStoppedTurn()
        finishTrace('cancelled', 'agent.stopped', { reason: 'run_not_running' })
        return
      }
      // compactionPlugin 是 Stage 1 唯一的 transformContext 注册者，draft.compaction 必被写回；
      // messages 与 compaction 局部变量刻意沿用旧名——下方 contextStats / requestBase / llmSpan
      // attrs 一个字都不用改，把集成 diff 压到最小。
      const messages = draft.messages
      const compaction = draft.compaction!
      const cacheProfile = contextCacheTracker.observe({
        lane: 'main',
        scope: `${id}:${runId}:${ROOT_AGENT_PATH}`,
        vendor: meta.settings.vendor,
        model: meta.settings.model,
        messages,
        // 整个稳定前缀（固定 system + skill 清单 + 工具摘要 + 自定义指令）都参与
        // systemFingerprint：改自定义指令、增删/改写 skill 或工具摘要 = 换 profile，
        // 而不是被误记成尾巴或投影变化。
        systemContent: stablePrefixContent,
        tools,
        toolChoice: 'auto',
        thinking: thinking?.type,
        reasoningEffort: meta.settings.reasoning_effort,
        compacted: compaction.compacted,
        dynamicControls,
        requestMode: 'tool_loop',
      })
      const lastCacheTotals = core
        .getSessionStore(id)
        .store
        .getter(contextStatsAtom)
        ?.cacheTotals
      const previousCacheTotals =
        lastCacheTotals?.profileId === cacheProfile.profileId
        && lastCacheTotals.epoch === cacheProfile.epoch
          ? lastCacheTotals
          : undefined
      const contextStats = buildContextStatsSnapshot({
        runId,
        turnId,
        llmTurn: turn + 1,
        vendor: meta.settings.vendor,
        model: meta.settings.model,
        messages,
        tools,
        cacheProfile,
        cacheTotals: previousCacheTotals,
        // 全部输入（messages + tools）可占用的总额度，供 UI 百分比使用。
        // 这与 compaction 的请求总预算同源，但不减工具 schema，避免 schema 很大时把分母算小。
        inputBudgetTokens: contextInputBudgetTokens(
          meta.settings.vendor,
          meta.settings.model,
          meta.settings.max_tokens,
        ),
      })
      setContextStats(id, contextStats, core)
      // tools 卡片按 turn 判重（其余三类只在循环外按 run 判重一次）：lazy-load 可能在任意一个
      // turn 让可见工具集变化，只有指纹真的变化的那一轮才记新卡片；首 turn（指纹尚未记录过）恒记一次。
      const toolsFingerprint = toolSetSchemaFingerprint(tools)
      const priorInjectionFingerprints = getTranscriptInjectionFingerprints(id, core)
      if (priorInjectionFingerprints.toolsFingerprint !== toolsFingerprint) {
        const isFirstToolsRecord = priorInjectionFingerprints.toolsFingerprint === undefined
        addTranscriptEvent(
          id,
          'tool_manifest',
          isFirstToolsRecord ? '注入 tools' : '工具集已更新',
          toolManifestSummary(tools, isFirstToolsRecord ? undefined : priorInjectionFingerprints.toolsCount),
          tools,
          core,
        )
        patchTranscriptInjectionFingerprints(id, { toolsFingerprint, toolsCount: tools.length }, core)
      }
      traceEvent('llm.tools_injected', {
        tools_count: tools.length,
        tool_names: names.join(','),
      })
      traceEvent('llm.context_snapshot', {
        llm_turn: contextStats.llmTurn,
        messages_count: contextStats.messagesCount,
        tools_count: contextStats.toolsCount,
        estimated_tokens: contextStats.estimatedTokens,
        total_chars: contextStats.totalChars,
        messages_chars: contextStats.messagesChars,
        tools_chars: contextStats.toolsChars,
        cache_profile: cacheProfile.profileId,
        cache_epoch: cacheProfile.epoch,
        cache_lane: cacheProfile.lane,
        cache_epoch_reason: cacheProfile.epochReason,
        cache_lane_scope_fingerprint: cacheProfile.laneScopeFingerprint,
        cache_system_fingerprint: cacheProfile.systemFingerprint,
        cache_request_projection_fingerprint: cacheProfile.requestProjectionFingerprint,
        tool_set_fingerprint: cacheProfile.toolSetFingerprint,
        cache_compaction_boundary: cacheProfile.compactionBoundary,
      })
      // 压缩可见性事件（'llm.context_compacted' / 'llm.context_over_budget'）已由 compactionPlugin
      // 在 transformContext 里经 ctx.traceEvent 发出——attr 名 / 值逐字对齐旧内联代码（含
      // context_window_tk / budget_source / _tk 后缀那套避 redact 的口径）。这里【不能再发一遍】，
      // 否则每次压缩都会双发同名事件。两个事件独立、不互斥（压过必发前者；压完仍超再发后者）。

      // 按 vendor 收窄 settings 后调 model（流式；最终仍归一成完整 ModelChatResponse）。
      // DeepSeek 的 insufficient_system_resource 是 200 响应里的协议级容量信号，不会触发
      // modelApi 已有的 429/5xx/网络错误退避。这里在【尚无流式条目写回】时有限重放同一请求；
      // 其它 HTTP 错误仍直接由 adapter 处理，主 runtime 不额外 catch/重试，避免双重 retry。
      const requestBase = {
        model: meta.settings.model,
        messages,
        temperature: meta.settings.temperature,
        max_tokens: meta.settings.max_tokens,
        thinking,
        tools,
        tool_choice: 'auto' as const,
        stream: true,
      }
      let insufficientResourceRetries = 0
      let completedResponse: {
        res: ModelChatResponse
        streamWriter: ReturnType<typeof createAssistantStreamWriter>
      } | undefined

      while (!completedResponse) {
        const streamWriter = createAssistantStreamWriter(id, runId, opts.signal, core, planStageId)
        let res: ModelChatResponse
        const llmSpan = startSpan('llm.chat', {
          kind: 'llm',
          parent: traceSpan,
          attrs: () => ({
            sessionId: id,
            runId,
            turnId,
            vendor: meta.settings.vendor,
            model: meta.settings.model,
            messages_count: messages.length,
            tools_count: tools.length,
            insufficient_resource_retry_attempt: insufficientResourceRetries,
            estimated_context_tokens: contextStats.estimatedTokens,
            context_chars: contextStats.totalChars,
            tools_chars: contextStats.toolsChars,
            context_compacted: compaction.compacted,
            context_within_budget: compaction.withinBudget,
            cache_profile: cacheProfile.profileId,
            cache_epoch: cacheProfile.epoch,
            cache_lane: cacheProfile.lane,
            cache_epoch_reason: cacheProfile.epochReason,
            cache_lane_scope_fingerprint: cacheProfile.laneScopeFingerprint,
            cache_system_fingerprint: cacheProfile.systemFingerprint,
            cache_request_projection_fingerprint: cacheProfile.requestProjectionFingerprint,
            tool_set_fingerprint: cacheProfile.toolSetFingerprint,
            requestPreview: llmTracePreview({
              ...requestBase,
              reasoning_effort: meta.settings.reasoning_effort,
            }),
          }),
        })
        try {
          if (meta.settings.vendor === 'glm') {
            const s = meta.settings
            const requestBody: GlmChatRequest = { ...requestBase, reasoning_effort: s.reasoning_effort }
            res = await streamGlm(requestBody, callOptions, { onDelta: streamWriter.onDelta })
          } else {
            const s = meta.settings
            const requestBody: DeepSeekChatRequest = {
              ...requestBase,
              reasoning_effort: s.reasoning_effort,
              user_id: core.config.deepseekUserId,
            }
            res = await streamDeepSeek(requestBody, callOptions, { onDelta: streamWriter.onDelta })
          }
        } catch (err) {
          // 网络错误/取消也要把最后一个尚未到节流窗口的 delta 对账进稳定条目，并清掉瞬态流。
          streamWriter.finishPending()
          const status = abortStatus(opts.signal, err)
          endSpan(llmSpan, status, {
            error: safeErrorMessage(err),
            cache_metrics_status: status === 'cancelled' ? 'cancelled' : 'request_failed',
          }, err)
          if (insufficientResourceRetries > 0) {
            traceEvent('llm.insufficient_system_resource_exhausted', {
              retries_used: insufficientResourceRetries,
              max_retries: MAX_DEEPSEEK_INSUFFICIENT_RESOURCE_RETRIES,
              reason: status === 'cancelled'
                ? 'retry_request_cancelled'
                : 'retry_request_failed',
              error: safeErrorMessage(err),
            })
          }
          if (isCurrentRun(currentRunGuard)) {
            setContextStats(id, {
              ...contextStats,
              cache: {
                ...contextStats.cache!,
                metricsStatus: status === 'cancelled' ? 'cancelled' : 'request_failed',
              },
            }, core)
          }
          throw err
        }
        const choice = res.choices?.[0]
        const msg = choice?.message
        const toolCalls = narrowToolCalls(msg?.tool_calls)
        const rawToolCallsCount = Array.isArray(msg?.tool_calls) ? msg.tool_calls.length : 0
        endSpan(llmSpan, 'ok', () => ({
          finish_reason: choice?.finish_reason ?? null,
          tool_calls_count: toolCalls.length,
          content_chars: responseChars(msg?.content),
          reasoning_chars: responseChars(msg?.reasoning_content),
          response_id: res.id,
          response_model: res.model,
          insufficient_resource_retry_attempt: insufficientResourceRetries,
          cache_metrics_status: normalizeCacheUsage(res.usage) ? 'available' : 'unavailable',
          responsePreview: llmTracePreview(res),
          ...usageTraceAttrs(res.usage),
        }))

        // TK8 每步守卫必须先于协议级 retry：迟到的旧 run 和已 abort 的 run 连请求都不能再发一次。
        if (!isCurrentRun(currentRunGuard)) {
          streamWriter.finishPending()
          finishTrace('cancelled', 'agent.stale_run', { reason: 'stale_run' })
          return
        }
        if (!isRunningRun(id, runId, core)) {
          streamWriter.finishPending()
          commitStoppedTurn()
          finishTrace('cancelled', 'agent.stopped', { reason: 'run_not_running' })
          return
        }
        // esc race：fetch 在 abort 前已返回但 signal 已中断 → stopped，不写回，也不容量重试。
        if (opts.signal.aborted) {
          streamWriter.finishPending()
          if (isCurrentRun(currentRunGuard)) patchRun(id, { status: 'stopped' }, core)
          commitStoppedTurn()
          finishTrace('cancelled', 'agent.stopped', { reason: 'aborted' })
          return
        }

        if (
          meta.settings.vendor === 'deepseek'
          && choice?.finish_reason === 'insufficient_system_resource'
        ) {
          const hasStreamedItem = streamWriter.hasItem()
          const hasResponseText = responseChars(msg?.content) > 0
            || responseChars(msg?.reasoning_content) > 0
          if (
            !hasStreamedItem
            && !hasResponseText
            && rawToolCallsCount === 0
            && insufficientResourceRetries < MAX_DEEPSEEK_INSUFFICIENT_RESOURCE_RETRIES
          ) {
            insufficientResourceRetries += 1
            traceEvent('llm.insufficient_system_resource_retry', {
              retry_attempt: insufficientResourceRetries,
              max_retries: MAX_DEEPSEEK_INSUFFICIENT_RESOURCE_RETRIES,
              response_id: res.id,
              response_model: res.model,
              has_streamed_item: false,
              has_response_text: false,
            })
            continue
          }
          traceEvent('llm.insufficient_system_resource_exhausted', {
            retries_used: insufficientResourceRetries,
            max_retries: MAX_DEEPSEEK_INSUFFICIENT_RESOURCE_RETRIES,
            reason: hasStreamedItem
              ? 'streamed_output_already_written'
              : hasResponseText
                ? 'response_text_returned'
                : rawToolCallsCount > 0
                  ? 'tool_calls_returned'
                  : 'retry_limit_reached',
            response_id: res.id,
            response_model: res.model,
            has_streamed_item: hasStreamedItem,
            has_response_text: hasResponseText,
            tool_calls_count: toolCalls.length,
            raw_tool_calls_count: rawToolCallsCount,
          })
        } else if (insufficientResourceRetries > 0) {
          traceEvent('llm.insufficient_system_resource_recovered', {
            retries_used: insufficientResourceRetries,
            final_finish_reason: choice?.finish_reason ?? null,
            response_id: res.id,
            response_model: res.model,
          })
        }

        completedResponse = { res, streamWriter }
      }

      const { res, streamWriter } = completedResponse
      const choice = res.choices?.[0]
      const msg = choice?.message
      const toolCalls = narrowToolCalls(msg?.tool_calls)
      const responseCacheUsage = normalizeCacheUsage(res.usage)

      setContextStats(id, {
        ...contextStats,
        usage: usageStats(res.usage),
        cache: {
          ...contextStats.cache!,
          metricsStatus: responseCacheUsage ? 'available' : 'unavailable',
        },
        cacheTotals: accumulateCacheTotals(previousCacheTotals, res.usage, cacheProfile),
        finishReason: choice?.finish_reason ?? null,
        responseModel: res.model,
      }, core)

      const assistantHasContent = typeof msg?.content === 'string' && msg.content.trim().length > 0
      // ── finish_reason 异常三态 + 循环检测：收尾判定统一走 onTurnEnd fan-out（PX3）。
      //   循环检测的跨轮累计（原 consecutiveToolOnlyTurns / repeatedToolSignatures + isToolOnlyTurn 判据 +
      //   达阈值中止）已整体搬进 loopGuardPlugin 的 per-run 闭包（onTurnEnd）。assistantHasContent 现在只
      //   喂给 loopGuard 事件（旧代码它还兼判 isToolOnlyTurn / 拼 notice，两处均已随插件搬走）。
      // setContextStats 上面已把 finishReason 记进 UI 快照，但那只是「记下来」；这里负责让异常
      // 真的发生作用：不静默续跑、不把被掐断的半截输出当成正常答案收尾。
      const finishReason = choice?.finish_reason ?? null
      // 触顶且带 tool_calls：arguments JSON 极可能是半截的 —— 这里【不】终止（终止会留下没有结果的
      //   tool_calls），保留原 trace，放行给下面逐个 tool_call 的参数解析：坏 JSON 会被回填成错误结果，
      //   序列保持合法、model 看得见问题并可重发。该组合不参与下面 onTurnEnd 的异常终止决策。
      if (finishReason === 'length' && toolCalls.length > 0) {
        traceEvent('llm.finish_length_tool_calls', {
          finish_reason: finishReason,
          tool_calls_count: toolCalls.length,
          hint: '输出触顶，tool_call 参数可能被截断',
        })
      }
      // onTurnEnd 事件是 loop 与插件共用的完整契约。异常 finish 判据也从这份事件单源取得，避免 loop
      // 与 finishReasonPlugin 各自维护 length + tool_calls 的可恢复例外。
      const turnEndEvent: TurnEndEvent = {
        finishReason,
        toolCalls,
        assistantHasContent,
        msg,
        hasStreamedItem: streamWriter.hasItem(),
      }
      const abnormalFinish: AbnormalFinishReason | undefined = getAbnormalFinishReason(turnEndEvent)
      // Case A（流式已建条目）的系统标注必须由 loop 侧在 onTurnEnd【之前】finalize 追加 —— 完整正文只
      //   活在 streamWriter 闭包里（flush 有自适应节流），插件从 store 只能拿到最后一次节流快照，自己拼
      //   标注会把末尾那截文字顶掉（这就是「流式风险挡在插件外」）。传 toolCalls=undefined：assistantItem-
      //   FromMessage 只看第三参、不回落 msg.tool_calls，绝不落没有 result 的孤儿 tool_calls（本分支要终止、
      //   不执行工具）；finalize 在 !assistantItemId（Case B 非流式）时直接 return，与插件补条目不冲突。
      if (abnormalFinish) {
        streamWriter.finalize(msg, undefined, FINISH_REASON_ITEM_NOTICES[abnormalFinish])
      }
      // onTurnEnd fan-out：loopGuard（跨轮重复工具调用累计 + 命中即中止）先、finishReason（异常三态中止 +
      //   补 Case B 非流式标注条目）后，首个 stop 胜且短路——复刻旧代码「循环检测 block 在 finish_reason
      //   block 之前」的评估序。loopGuard 每轮都要累计/清零，故 onTurnEnd 无条件每轮调一次。共享事件契约
      //   已带齐两个插件所需的瞬时字段；onTurnEnd 是循环内 await 收尾点，命中收尾里的 commitTurn/patchRun
      //   各自带 isCurrentRun 守卫（stale/ghost 不写）。
      const decision = await hooks.onTurnEnd?.(ctx, turnEndEvent)
      if (!isRunningRun(id, runId, core)) {
        streamWriter.finishPending()
        commitStoppedTurn()
        finishTrace('cancelled', 'agent.stopped', { reason: 'run_not_running' })
        return
      }
      if (decision?.stop) {
        if (abnormalFinish) {
          // finish_abnormal 收尾（条目已由 finishReasonPlugin 在 onTurnEnd 内按 Case A/B 落好）：★ 照常
          //   commitCheckpoint + 落盘 ★——本轮虽收成 error 但条目已进 itemsAtom，而 itemsAtom 不持久化，
          //   不落 checkpoint 用户刷新后连自己那条 user 消息都会一起蒸发。异常结果保存在结构化字段。
          commitTurn({ kind: 'abnormal', finishReason: abnormalFinish })
          if (isCurrentRun(currentRunGuard)) {
            patchRun(id, { status: decision.runStatus, error: decision.reason }, core)
          }
          finishTrace('error', decision.traceEventName, {
            finish_reason: finishReason,
            tool_calls_count: toolCalls.length,
            content_chars: responseChars(msg?.content),
            error: decision.reason,
          })
        } else {
          // loop_detected 收尾（纯工具轮无正文，只 finishPending 对账、不补条目——回归测试钉死命中轮无新
          //   assistant 条目）：commitTurn 无 label；事件名 + 全套 attrs 由 loopGuardPlugin 经 decision 交回，
          //   finishTrace 一次落地（发 'agent.loop_detected' 事件 + 关闭 turn span 同一份 attrs，与旧逐字一致）。
          //   走到这里即：decision.stop 为真但 abnormalFinish 未设 —— 只可能是 loopGuard 命中（finishReason
          //   ='tool_calls'，与异常三态互斥）；完整 stop decision 必带 traceEventName/traceAttrs。
          streamWriter.finishPending()
          commitTurn()
          if (isCurrentRun(currentRunGuard)) {
            patchRun(id, { status: decision.runStatus, error: decision.reason }, core)
          }
          finishTrace('error', decision.traceEventName, decision.traceAttrs)
        }
        return
      }

      const streamedAssistantItemId = streamWriter.finalize(msg, toolCalls)

      // ── 有 tool_calls：先 append assistant(tool_calls)，再补齐「每个 tool_call 都要有对应 tool result」。
      // 关键（codex P2）：若同一条 assistant.tool_calls 里既有合法 ask_user_question 又有其它工具，
      // 必须先把其它工具全执行、补齐 result，最后再处理 ask_user 的暂停/已答 —— 否则一旦提前 return
      // 进 waiting_user，同条消息里其余 tool_call 就缺 tool 消息，resume 重发会被 OpenAI 兼容接口
      // 拒绝（每个 tool_call 必须有匹配的 tool result）。
      if (toolCalls.length > 0) {
        consecutivePlanTextTurns = 0
        if (!streamedAssistantItemId) {
          appendItem(id, {
            id: newId(),
            createdAt: Date.now(),
            planStageId,
            item: assistantItemFromMessage(msg, msg?.content ?? null, toolCalls),
          }, core)
        }
        persistWorkingTurn()

        // 本批至多允许「一个」中断（ask_user 暂停 或 危险工具确认）——先记着，等同条消息里其它
        // tool_call 都补齐 result 再统一处理。否则提前 return 会漏掉其余 tool_call 的 tool 消息，
        // resume 重发被 OpenAI 兼容接口拒（每个 tool_call 必须有匹配 result，codex P2）。
        let pauseCall: { callId: string; payload: unknown } | undefined // ask_user 暂停
        let confirmCall: PendingToolConfirmation | undefined // S4-B 危险工具确认
        // 已有任一中断挂起 → 后来的中断只能退化成「已在等待」的占位 error result，避免 orphan。
        const interruptPending = () => pauseCall !== undefined || confirmCall !== undefined
        const executeToolCall = async (
          callId: string,
          name: string,
          args: Record<string, unknown>,
          expectedRegistrationVersion: number,
        ): Promise<ToolResult> => {
          const policy = core.tools.execution(name)
          const toolSpan = startSpan('tool.call', {
            kind: 'tool',
            parent: traceSpan,
            attrs: { sessionId: id, runId, turnId, toolName: name, callId, args },
          })
          try {
            const result = await getExecutionRuntime(core).run({
              id: callId,
              graphId: runId,
              sessionId: id,
              runId,
              type: 'tool',
              label: name,
              effectKeys: [...(policy?.effectKeys ?? [])],
              signal: opts.signal,
              task: async (signal) => {
                const ctx = buildToolContext({
                  sessionId: id,
                  runId,
                  signal,
                  callId,
                  toolName: name,
                  toolArgs: args,
                  agentPath: ROOT_AGENT_PATH,
                  getParentTranscript: rootTranscript,
                  delegateRuntime,
                  core,
                })
                return core.tools.run(name, args, ctx, expectedRegistrationVersion)
              },
            })
            const traced = toolResultTrace(result, args)
            endSpan(toolSpan, traced.status, traced.attrs, traced.err)
            return result
          } catch (err) {
            endSpan(toolSpan, abortStatus(opts.signal, err), { error: safeErrorMessage(err) }, err)
            throw err
          } finally {
            removeToolActivity(id, callId, core)
          }
        }

        // A model response is already a natural execution batch. Explicitly read-only tools
        // can run as siblings; everything else stays on the ordered path below. This keeps
        // confirmation, pause and mutations deterministic while allowing independent reads
        // to use the execution graph concurrently.
        const parallelCalls = toolCalls.flatMap((toolCall) => {
          const parsed = parseToolCallArgs(toolCall.function.arguments)
          if (!parsed.ok) return []
          const name = toolCall.function.name
          if (toolCallValidationError(name, parsed.args)) return []
          const expectedRegistrationVersion = exposedRegistrationVersions.get(name)
          if (
            expectedRegistrationVersion === undefined
            || core.tools.registrationVersion(name) !== expectedRegistrationVersion
          ) {
            return []
          }
          if (core.tools.execution(name)?.mode !== 'parallel') return []
          const meta = core.rootStore.getter(sessionsAtom)[id]
          const workspaceRoot = resolveSessionWorkspaceRoot(
            meta,
            core.rootStore.getter(workspacesAtom),
          )
          const risk = classifyToolRisk(name, parsed.args, { workspaceRoot })
          if (risk.requiresConfirmation || risk.level === 'critical' || risk.level === 'dangerous') return []
          return [{ callId: toolCall.id, name, args: parsed.args, expectedRegistrationVersion }]
        })
        if (parallelCalls.length === toolCalls.length && parallelCalls.length > 1) {
          const results = await Promise.all(
            parallelCalls.map((call) => executeToolCall(
              call.callId,
              call.name,
              call.args,
              call.expectedRegistrationVersion,
            )),
          )
          if (!isCurrentRun(currentRunGuard)) {
            finishTrace('cancelled', 'agent.stale_run', { reason: 'stale_run' })
            return
          }
          if (!isRunningRun(id, runId, core)) {
            commitStoppedTurn()
            finishTrace('cancelled', 'agent.stopped', { reason: 'run_not_running' })
            return
          }
          if (opts.signal.aborted) {
            patchRun(id, { status: 'stopped' }, core)
            commitStoppedTurn()
            finishTrace('cancelled', 'agent.stopped', { reason: 'aborted' })
            return
          }
          results.forEach((result, index) => {
            // 失败计数与顺序分支同口径：失败累加、成功/暂停清零（并发批的每个结果都要过一遍）。
            recordToolOutcome(parallelCalls[index].name, result)
            appendMappedToolResult(id, parallelCalls[index].callId, result, core, planStageId)
          })
          persistWorkingTurn()
          continue
        }

        for (const toolCall of toolCalls) {
          const name = toolCall.function.name
          const parsedArgs = parseToolCallArgs(toolCall.function.arguments)
          if (!parsedArgs.ok) {
            // 参数是坏 JSON（最常见成因就是上面那条 finish_reason='length' 截断）：
            //   · 【不执行】该工具 —— 把半截 JSON 降级成 {} 再照常执行，等于拿默认参数干活，
            //     比直接报错危险得多（save_file 少个 path、shell 少个 command 之类）。
            //   · 【必须回填】一条错误 tool 结果 —— 每个 tool_call 都得有对应 tool 消息，
            //     漏一条下一轮重发的消息序列就非法，整个 run 会被接口拒。
            //   模型据此知道自己的 JSON 坏了并可重发；循环继续（TK6 错误不打断）。
            const resultPayload = {
              error: parsedArgs.error,
              hint: '请重新发起该工具调用，并确保 arguments 是完整合法的 JSON 对象',
              argumentsPreview: argsPreviewForModel(parsedArgs.raw),
            }
            const attrs: TraceAttributes = {
              toolName: name,
              callId: toolCall.id,
              args_parse_failed: true,
              finish_reason: finishReason,
              argsPreview: tracePreview(parsedArgs.raw),
              resultPreview: tracePreview(resultPayload),
              errorPreview: parsedArgs.error,
              error: parsedArgs.error,
            }
            traceEvent('tool.args_invalid', attrs)
            const parseSpan = startSpan('tool.call', {
              kind: 'tool',
              parent: traceSpan,
              attrs: { sessionId: id, runId, turnId, ...attrs },
            })
            endSpan(parseSpan, 'error', attrs, parsedArgs.error)
            appendToolResult(id, toolCall.id, JSON.stringify(resultPayload), core, planStageId)
            continue
          }
          const args = parsedArgs.args

          // Lazy-tool 强制闸门：provider 偶尔会无视 tools 列表，凭 system 里的能力名直接生成
          // tool_call。只允许执行【这一轮请求实际暴露】的工具；否则不得进入风险判定、schema
          // 校验或 execute。
          // 这里以本轮发给 provider 的 tools 为准，而非 registry/visible：它同时覆盖环境过滤与
          // allowedToolNames 收窄，避免“已注册但本轮不可见”的工具被幻觉调用后仍然执行。
          if (!tools.some((tool) => tool.function.name === name)) {
            // ★ 已注册工具：把这次直接调用【当作一次加载请求】★
            //   稳定前缀里的工具摘要给了模型精确名字，它于是常常跳过 request_tool_schema 直接
            //   指名道姓地调用（2026-07-27 实测：摘要上线后的两个冷启动会话，首轮工具调用
            //   2/2 全被拒，各白烧一整轮；上线前 402 次请求零发生）。而这次调用本身已经把
            //   「我要用哪个工具」说清楚了 —— 那正是 request_tool_schema 唯一要问的事，
            //   没有理由再逼它用另一个工具名把同一句话重说一遍。
            //   于是走【同一条】lazy 通道：ensureToolLoaded 装进 visible，下一轮起随 tools
            //   长期携带，与 request_tool_schema 的效果逐字一致。
            //   ★ 机制没有被绕过 ★：本次调用仍然不执行，猜测的参数一律不落地；完整
            //   inputSchema 仍然只经顶层 tools 下发、不进消息历史（见 toolSchemaAutoloadedResult）。
            //   TP3：web 下的 server 工具既不进摘要也不该被加载，与未注册的幻觉工具一起继续
            //   走下面的硬拒绝 —— 那时模型是真的调了一个当前环境不存在的能力。
            const autoloadable = core.tools.loadSchema(name)
            if (autoloadable && (autoloadable.runtime !== 'server' || runtimeIsTauri)) {
              visible = ensureToolLoaded(id, visible, name, core, MAX_TURN_TOOLS - 1)
              recentToolNames = touchRecentToolName(recentToolNames, name)
              const resultPayload = toolSchemaAutoloadedResult(autoloadable)
              const attrs: TraceAttributes = {
                toolName: name,
                callId: toolCall.id,
                schema_autoloaded: true,
                argsPreview: tracePreview(args),
                resultPreview: tracePreview(resultPayload),
              }
              traceEvent('tool.schema_autoloaded', attrs)
              // span 用 request_tool_schema 而非 tool.call：它记的是一次 schema 加载，
              // 不是一次工具执行，也不该把 tool.call 的错误率算脏。
              const autoloadSpan = startSpan('request_tool_schema', {
                kind: 'internal',
                parent: traceSpan,
                attrs: { sessionId: id, runId, turnId, toolName: name, callId: toolCall.id, args },
              })
              endSpan(autoloadSpan, 'ok', {
                found: true,
                autoloaded: true,
                discovery: false,
                result: resultPayload,
              })
              // 阶段仍未关闭：续跑提醒要说明这次提交没落地，否则模型会以为阶段已提交。
              if (name === 'submit_stage_result') lastStageSubmitRejection = resultPayload.hint
              appendToolResult(id, toolCall.id, JSON.stringify(resultPayload), core, planStageId)
              continue
            }

            const resultPayload = toolSchemaNotLoadedResult(name)
            const error = String(resultPayload.error)
            const attrs: TraceAttributes = {
              toolName: name,
              callId: toolCall.id,
              schema_not_loaded: true,
              argsPreview: tracePreview(args),
              resultPreview: tracePreview(resultPayload),
              errorPreview: error,
              error,
            }
            traceEvent('tool.schema_not_loaded', attrs)
            const unloadedSpan = startSpan('tool.call', {
              kind: 'tool',
              parent: traceSpan,
              attrs: { sessionId: id, runId, turnId, ...attrs },
            })
            endSpan(unloadedSpan, 'error', attrs, error)
            if (name === 'submit_stage_result') lastStageSubmitRejection = error
            appendToolResult(id, toolCall.id, JSON.stringify(resultPayload), core, planStageId)
            continue
          }

          const expectedRegistrationVersion = exposedRegistrationVersions.get(name)
          const currentRegistrationVersion = core.tools.registrationVersion(name)
          if (
            name !== 'request_tool_schema'
            && (
              expectedRegistrationVersion === undefined
              || currentRegistrationVersion !== expectedRegistrationVersion
            )
          ) {
            const resultPayload = toolRegistrationChangedResult(
              name,
              expectedRegistrationVersion,
              currentRegistrationVersion,
            )
            const error = String(resultPayload.error)
            const attrs: TraceAttributes = {
              toolName: name,
              callId: toolCall.id,
              registration_changed: true,
              expectedRegistrationVersion,
              currentRegistrationVersion,
              argsPreview: tracePreview(args),
              resultPreview: tracePreview(resultPayload),
              errorPreview: error,
              error,
            }
            traceEvent('tool.registration_changed', attrs)
            const changedSpan = startSpan('tool.call', {
              kind: 'tool',
              parent: traceSpan,
              attrs: { sessionId: id, runId, turnId, ...attrs },
            })
            endSpan(changedSpan, 'error', attrs, error)
            if (name === 'submit_stage_result') lastStageSubmitRejection = error
            appendToolResult(id, toolCall.id, JSON.stringify(resultPayload), core, planStageId)
            continue
          }

          const validationError = toolCallValidationError(name, args)
          if (validationError) {
            const resultPayload = { error: validationError }
            const attrs: TraceAttributes = {
              toolName: name,
              callId: toolCall.id,
              validation_failed: true,
              argsPreview: tracePreview(args),
              resultPreview: tracePreview(resultPayload),
              errorPreview: validationError,
              validationError,
              error: validationError,
            }
            traceEvent('tool.validation_failed', attrs)
            const validationSpan = startSpan('tool.call', {
              kind: 'tool',
              parent: traceSpan,
              attrs: { sessionId: id, runId, turnId, ...attrs },
            })
            endSpan(validationSpan, 'error', attrs, validationError)
            if (name === 'submit_stage_result') lastStageSubmitRejection = validationError
            appendToolResult(id, toolCall.id, JSON.stringify(resultPayload), core, planStageId)
            continue
          }

          // request_tool_schema：完整 schema 只进入下一轮请求的顶层 tools；历史结果仅保留加载确认和 guide。
          if (name === 'request_tool_schema') {
            const toolName = typeof args.toolName === 'string' ? args.toolName.trim() : ''
            const schemaSpan = startSpan('request_tool_schema', {
              kind: 'internal',
              parent: traceSpan,
              attrs: { sessionId: id, runId, turnId, toolName, callId: toolCall.id, args },
            })
            let found: boolean
            let resultPayload: Record<string, unknown>
            if (toolName) {
              // ensureToolLoaded 已穿 core（toolLoading.ts）：读 core.tools + patchRun(..., core)，
              // 与紧邻的 core.tools.loadSchema 同源。默认 core=defaultCore 时行为零变化，隔离实例走本核。
              visible = ensureToolLoaded(
                id,
                visible,
                toolName,
                core,
                MAX_TURN_TOOLS - 1,
              )
              const schema = core.tools.loadSchema(toolName)
              found = schema !== undefined
              if (schema) recentToolNames = touchRecentToolName(recentToolNames, toolName)
              resultPayload = schema ? toolSchemaLoadedResult(schema) : { error: 'unknown' }
            } else {
              const manifest = searchToolManifestPage(
                {
                  query: typeof args.query === 'string' ? args.query : undefined,
                  cursor: typeof args.cursor === 'string' ? args.cursor : undefined,
                  limit: typeof args.limit === 'number' ? args.limit : undefined,
                },
                isTauri(),
                { registry: core.tools },
              )
              found = manifest.kind === 'tool_manifest_page'
              resultPayload = manifest as unknown as Record<string, unknown>
            }
            traceEvent('tool.schema_requested', {
              toolName: toolName || undefined,
              discovery: !toolName,
              callId: toolCall.id,
              found,
              args,
              result: resultPayload,
            })
            endSpan(schemaSpan, found ? 'ok' : 'error', {
              found,
              discovery: !toolName,
              result: resultPayload,
            })
            appendToolResult(id, toolCall.id, JSON.stringify(resultPayload), core, planStageId)
            continue
          }

          // request_tool_schema 已在上面 continue；其它可见工具通过注册版本守卫后必有版本。
          const registrationVersion = expectedRegistrationVersion!

          // S4-B 工具确认门：confirm 模式沿用变更类工具逐次确认；auto 仅确认 critical。
          // critical 的优先级高于「本 session 一律允许」，不能被工具名级白名单绕过。
          // 命中即延后为 confirmCall（不建 ctx、不执行、不回填 result，留给 confirmTool 恢复时处理）。
          const meta = core.rootStore.getter(sessionsAtom)[id]
          const workspaceRoot = resolveSessionWorkspaceRoot(
            meta,
            core.rootStore.getter(workspacesAtom),
          )
          const risk = classifyToolRisk(name, args, { workspaceRoot })
          const approvalMode = meta?.toolApprovalMode ?? 'confirm'
          const needsConfirmation = risk.requiresConfirmation === true
            || risk.level === 'critical'
            || (approvalMode === 'confirm'
              && risk.level === 'dangerous'
              && !isToolAlwaysAllowed(id, name, core))
          if (needsConfirmation) {
            if (interruptPending()) {
              // 同批已有一个待确认/待暂停 → 该危险工具先回占位 error（resume 只处理一个中断）。
              appendToolResult(id, toolCall.id, JSON.stringify({ error: '已有待确认的工具调用，请先处理' }), core, planStageId)
            } else {
              confirmCall = risk.level === 'critical' || risk.requiresConfirmation
                ? {
                    callId: toolCall.id,
                    toolName: name,
                    args,
                    registrationVersion,
                    ...(risk.level === 'critical' ? { risk: 'critical' as const } : { risk: 'dangerous' as const }),
                    reason: risk.reason,
                    irreversible: risk.irreversible,
                  }
                : { callId: toolCall.id, toolName: name, args, registrationVersion }
            }
            continue
          }

          // 其它工具：由执行图记录其生命周期；串行/并发只由本批调度器决定。
          const result = await executeToolCall(toolCall.id, name, args, registrationVersion)

          // TK8「每步不漏」：execute 可能异步且 signal 穿透其中，await 后写回前再查会话还在、且仍是本次 run；
          // 被顶掉的旧 run 不得把迟到 result 写进新 run；esc 中断则收成 stopped。
          if (!isCurrentRun(currentRunGuard)) {
            finishTrace('cancelled', 'agent.stale_run', { reason: 'stale_run' })
            return
          }
          if (!isRunningRun(id, runId, core)) {
            commitStoppedTurn()
            finishTrace('cancelled', 'agent.stopped', { reason: 'run_not_running' })
            return
          }
          if (opts.signal.aborted) {
            if (isCurrentRun(currentRunGuard)) patchRun(id, { status: 'stopped' }, core)
            commitStoppedTurn()
            finishTrace('cancelled', 'agent.stopped', { reason: 'aborted' })
            return
          }

          // 失败计数：失败累加、成功/暂停清零（放在结果映射之前，pause 分支也要清）。
          recordToolOutcome(name, result)

          // 结果映射（§4）：pause 延后处理；ok → data JSON；error → {error} JSON（TK6，不打断）。
          if ('pause' in result) {
            if (interruptPending()) {
              // 已有中断（ask_user/危险工具）→ 这个多余的 pause 补个 result，别让它 orphan。
              appendToolResult(id, toolCall.id, JSON.stringify({ error: 'already pausing' }), core, planStageId)
            } else {
              pauseCall = { callId: toolCall.id, payload: result.pause } // 不 append，留给 resume 回填
            }
          } else {
            appendMappedToolResult(id, toolCall.id, result, core, planStageId)
            if (name === 'submit_stage_result') {
              // 提交成功 → 清除拒绝记录；否则记下失败原因，供下一次续跑提醒引用。
              lastStageSubmitRejection = result.ok ? undefined : result.error
            }
          }
        }

        // 其它工具已补齐，最后处理中断。S4-B 先处理危险工具确认：暂停 run（waiting_confirmation +
        //   pendingToolConfirmation），该 tool 的 result 留给 confirmTool 恢复时执行/回填。
        if (confirmCall) {
          traceEvent('agent.waiting_confirmation', {
            toolName: confirmCall.toolName,
            callId: confirmCall.callId,
            args: confirmCall.args,
          })
          patchRun(id, { status: 'waiting_confirmation', pendingToolConfirmation: confirmCall }, core)
          persistWorkingTurn()
          return
        }

        // 再处理 ask_user 暂停。每个新 callId 都代表一次独立决策，可以在同一 plan/run 中多次中断；
        // 当前 call 的 result 留给 resumeWithAnswers 精确回填。
        if (pauseCall) {
          const planApproval = planApprovalPayload(pauseCall.payload)
          if (planApproval) {
            traceEvent('agent.waiting_plan_approval', { callId: pauseCall.callId, ...planApproval })
            patchRun(id, {
              status: 'waiting_plan_approval',
              pendingPlanApproval: { callId: pauseCall.callId, ...planApproval },
            }, core)
            persistWorkingTurn()
            return
          }
          const origin = pendingDecisionOrigin(id, pauseCall.payload, planStageId, core)
          traceEvent('agent.waiting_user', {
            callId: pauseCall.callId,
            question_count: questionCount(pauseCall.payload),
            decision_surface: origin.surface,
            decision_phase: origin.phase,
            plan_id: origin.planId,
            plan_stage_id: origin.stageId,
          })
          patchRun(id, {
            status: 'waiting_user',
            pendingQuestion: pauseCall.payload,
            pendingUserDecision: {
              callId: pauseCall.callId,
              payload: pauseCall.payload,
              origin,
            },
          }, core)
          persistWorkingTurn()
          return
        }

        persistWorkingTurn()
        continue
      }

      // ── 无 tool_calls：最终答案。空回复（null/空串/纯空白）当失败，不写、不 commit。
      const content = msg?.content
      if (!content || !content.trim()) {
        if (isRunningRun(id, runId, core)) patchRun(id, { status: 'error', error: '模型返回空回复' }, core)
        persistWorkingTurn()
        finishTrace('error', 'agent.error', { error: '模型返回空回复' })
        return
      }

      if (!streamedAssistantItemId) {
        appendItem(id, {
          id: newId(),
          createdAt: Date.now(),
          planStageId,
          item: assistantItemFromMessage(msg, content),
        }, core)
      }

      const currentPlan = core.getSessionStore(id).store.getter(planAtom)
      if (currentPlan && EXECUTING_PLAN_STATUSES.has(currentPlan.status)) {
        consecutivePlanTextTurns += 1
        const currentStage = currentPlan.stages.find((stage) => stage.status === 'in_progress')
        if (consecutivePlanTextTurns >= MAX_CONSECUTIVE_PLAN_TEXT_TURNS) {
          const error = `计划执行连续 ${MAX_CONSECUTIVE_PLAN_TEXT_TURNS} 轮未调用工具，已停止自动续跑`
          if (isRunningRun(id, runId, core)) patchRun(id, { status: 'error', error }, core)
          persistWorkingTurn()
          finishTrace('error', 'agent.plan_continuation_stalled', {
            planId: currentPlan.id,
            planStatus: currentPlan.status,
            stageId: currentStage?.id,
            consecutive_text_turns: consecutivePlanTextTurns,
            error,
          })
          return
        }
        const noticeLines = [
          '结构化计划尚未完成，上一条文本只能视为阶段性说明，不能作为最终答案，也不能声称整个任务已完成。',
          `当前计划状态：${currentPlan.status}。`,
          currentStage
            ? `当前阶段：${currentStage.title}（${currentStage.status}）。`
            : '当前没有已完成验收的最终阶段，请调用 execute_plan 启动或恢复计划。',
        ]
        if (lastStageSubmitRejection) {
          // 关键修复：把上一次 submit_stage_result 的具体拒绝原因带进提醒，
          // 否则模型只会收到泛化的“继续执行”，无从得知自己卡在哪（schema 未加载 / 参数结构不对 / evaluator 拒绝）。
          noticeLines.push(
            `注意：你上一次 submit_stage_result 未成功，当前阶段仍未关闭。失败原因：${lastStageSubmitRejection}`,
            '请先针对该原因修正后重新调用 submit_stage_result（例如先 request_tool_schema 加载 schema、或按 schema 修正参数结构），不要用纯文本描述替代提交。',
          )
        } else {
          noticeLines.push(
            '继续执行计划；完成当前阶段产出后必须调用 submit_stage_result，由 evaluator 判定阶段与计划是否完成。',
          )
        }
        planContinuationNotice = noticeLines.join('\n')
        traceEvent('agent.plan_continuation_required', {
          planId: currentPlan.id,
          planStatus: currentPlan.status,
          stageId: currentStage?.id,
          submit_rejected: lastStageSubmitRejection !== undefined,
        })
        persistWorkingTurn()
        continue
      }

      // 当前 assistant 最终回复已落库；若请求飞行期间来了新输入，把它提升成普通 user 消息，
      // 同一 runId 直接进入下一轮。取队列与 done 写入之间没有 await，避免结束竞态。
      const promotedAfterReply = promoteQueuedInputs()
      if (promotedAfterReply > 0) {
        agentTurnLimit += Math.max(1, promotedAfterReply)
        resetToolFailureStreaks()
        persistWorkingTurn()
        continue
      }

      commitTurn() // TK9：一轮用户输入收尾 = 一个 checkpoint（并落盘）。
      if (isRunningRun(id, runId, core)) patchRun(id, { status: 'done', finishedAt: Date.now() }, core)
      finishTrace('ok', 'agent.done', { status: 'done' })
      return
    }

    // 循环跑满本次动态上限仍未收尾 → 降级为 error（TK8 上限保护）。
    // 同样要落盘：跑满上限意味着 itemsAtom 里已堆了大量 assistant/tool 条目，丢掉整轮
    // 代价最大（含用户那条 user 消息）。
    commitTurn()
    const error = `主 Agent 超过最大模型轮次（${agentTurnLimit}）`
    if (isRunningRun(id, runId, core)) patchRun(id, { status: 'error', error }, core)
    finishTrace('error', 'agent.max_turns', { max_turns: agentTurnLimit, error })
  } catch (err) {
    // U7 降级：被 esc 中断 → 'stopped'（仅当仍是本次 run，避免污染新 run）。
    // ★ 必须用 modelApi.isAbortError（按 name 鸭子类型），不能写 `err instanceof DOMException` ★ ——
    //   中断错误的标准形态是 DOMException('AbortError')，但 Tauri / node-fetch 等 fetch polyfill
    //   只抛一个 name==='AbortError' 的普通 Error。modelApi 那边已经按鸭子类型识别并如实透传，
    //   这边若还用 instanceof 就认不出来：用户按了停止键，run 却落成 'error' + 一段英文异常。
    //   判据必须和抛出侧（modelApi）保持同一份，否则每加一个 fetch 实现就复发一次。
    if (isAbortError(err)) {
      if (isCurrentRun(currentRunGuard)) patchRun(id, { status: 'stopped' }, core)
      commitStoppedTurn()
      finishTrace('cancelled', 'agent.stopped', { reason: 'abort_error' }, err)
      return
    }
    // 其它失败 → 'error'（不抛崩 UI；仅当仍是本次 run）。
    if (isRunningRun(id, runId, core)) {
      patchRun(id, { status: 'error', error: err instanceof Error ? err.message : String(err) }, core)
    }
    // stopped run 也需留下这轮工作快照；persistTurnSnapshot 自带 stale guard，故不会写入替代者。
    persistWorkingTurn()
    finishTrace('error', 'agent.error', { error: safeErrorMessage(err) }, err)
  } finally {
    // ★ finally 里的收尾绝不能抛 ★ —— 这个块和上面的 try/catch 是【平级】的，一旦 dispose
    //   抛出，异常会直接从 runToolLoop 逃逸，绕过刚刚做完的降级（AbortError→'stopped'、其它
    //   →'error'）：run 状态停在最后一次 patchRun 的值上，调用方的 endRun 执行与否也变得看天，
    //   而 U7 承诺的正是「绝不抛崩」。故整块吞异常、只留一条 trace。
    //   AbortError 在这里【也一并吞掉、不再透传】：走到 finally 时本轮结局早已判完并写回，
    //   dispose 被同一个 signal 取消只说明清理没做完，把它抛出去只会把一个已经收好的 run
    //   变成 reject —— 透传 AbortError 的意义在于让上面的 catch 认出「用户按了停止」，而这里
    //   已经在那个 catch 之后了，没有任何人会再消费它。
    try {
      // 父运行在 awaiting_tool 返回前已经 retain 了后台 execution 所需的 owner。
      // 无论本轮以何种状态返回，都应释放父 owner；否则后台结束后仍会残留一个 owner，
      // cancellation controller 与归档 writer 都无法真正清理。
      await delegateRuntime.dispose?.()
    } catch (err) {
      // 此时 finishTrace 已结束本轮 span；不能把清理失败事件再挂到已结束的 span 上。
      addEvent('agent.dispose_failed', {
        traceId: traceSpan.traceId,
        attrs: {
          ...baseTraceAttrs,
          error: safeErrorMessage(err),
          aborted: isAbortError(err) || opts.signal.aborted,
        },
      })
    }
  }
}
