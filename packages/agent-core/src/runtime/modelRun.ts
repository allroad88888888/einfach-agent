// 多轮 lazy-tool 对话 run —— 把用户输入送模型，按 model 决策循环调工具，直到最终答案。
// ---------------------------------------------------------------------------
// 契约（FEATURES-PLAN §1 T-6/T-7）：单轮 → 多轮 tool 循环 + ask_user 暂停/恢复。
//   · TK1 itemsAtom 直存：assistant(tool_calls) 与 tool result 直接 appendItem 进 itemsAtom，
//     每轮重新 `items.map(it=>it.item)` 重发；不用 continuation blob。
//   · TK3 manifest-only + lazy schema：model 只看 request_tool_schema + 本轮已加载 visible tools；
//     完整 schema 经 ensureToolLoaded 懒加载，禁止预加载。
//   · TK4 skill 走 tool：system 只放已加载 skill 名（buildSystemItem），内容不进 prompt。
//   · TK6 tool 错误不打断：runRuntimeTool 内部把失败封 {error} JSON 回给 model，loop 继续。
//   · TK7 ask_user「已回答」守卫：resume 后 model 再要求提问不再暂停（回 user_answers_already_provided）。
//   · TK8 每步守卫：每次 model 调用后写回前 isCurrentRun + ghost guard；MAX_AGENT_TURNS 上限。
//   · TK9 一轮 = 一个 checkpoint：中间 tool items 属同一轮，最终 assistant 后 commit 一次。
//   · U7 signal 全穿透 + 失败降级：AbortError→'stopped'；其它→'error'；绝不抛崩。
// 本文只编排 writers + api + 纯 helper（modelTurn），不持有/接收 store（U2），不 import UI（U1）。
//
// 【实例化 · 第 2 期穿线】runSession / runToolLoop 的 opts 加了可选 core（CoreInstance，默认 defaultCore）：
//   本文件里【每一处】原本摸模块全局的地方（rootStore / getSessionStore / toolRegistry）都改成读传入
//   core 的字段（core.rootStore / core.getSessionStore(id) / core.tools），调 writer 时把 core 作尾参传下，
//   建 toolContext / makeCoreCtx 时把 core 传进去。私有 helper（isCurrentRun / currentTurnItems /
//   createAssistantStreamWriter / appendToolResult 等）一律加【无默认值】的 core 形参 —— 编译期强制每个
//   调用点显式传，堵住「漏穿一处、默认路径无症状、只有双实例才串台」的隐患。默认 core=defaultCore＝穿线
//   前的模块全局单例（rootStore.ts / sessionStore.ts / tools/registry.ts 都已是 defaultCore 视图），故不传
//   core 的调用点（commands.ts 现有全部调用 + 所有现有测试）行为逐字不变。
//   ★ 本期未穿的隔离缺口（默认路径无影响，双实例时仍落 defaultCore，留待后续补）★：
//     · ensureToolLoaded（toolLoading.ts，非本文件）内部仍读 defaultCore.tools + 未穿 core 的 patchRun；
//     · isToolAlwaysAllowed（transientAtoms 纯读，writer 3 未给它加 core）仍读 defaultCore 视图；
//     · createDelegateAgentRuntime + 子 agent 委派路径（第二循环 / Phase 2.5 再穿）；
//     · persistSessions（persistenceBridge，非本文件）内部自取 defaultCore.rootStore。

import { isTauri } from '@tauri-apps/api/core'
import { sessionsAtom } from '../state/rootStore'
import { itemsAtom, runAtom, checkpointsAtom } from '../state/sessionAtoms'
import { appendItem, setRun, patchRun, updateItem } from '../state/sessionWriters'
import { commitCheckpoint } from '../state/checkpointWriters'
import {
  removeToolActivity,
  isToolAlwaysAllowed,
  addRuntimeTranscriptEvent,
  setContextStats,
  type ContextStatsSnapshot,
  type ContextUsageStats,
} from '../state/transientAtoms'
import { isDangerousTool } from './dangerousTools'
import type { PendingToolConfirmation } from '../state/core.type'
import { persistCheckpoint, persistSessions } from './persistenceBridge'
import { streamDeepSeek, type DeepSeekChatRequest } from '@web-agent/ai'
import { streamGlm, type GlmChatRequest } from '@web-agent/ai'
import { isAbortError } from '@web-agent/ai'
import type {
  AssistantItem,
  ModelChatResponse,
  ModelFunctionTool,
  ModelItem,
  ModelResponseMessage,
  ModelStreamDelta,
} from '@web-agent/ai'
import type { LoadedTool, ToolResult } from '../tools/types'
import { ensureToolLoaded } from './toolLoading'
import { buildToolContext } from './toolContext'
// 【实例化 · 第 2 期穿线】core（CoreInstance，默认 defaultCore）决定本 run 用谁的 store/registry/abort。
import { defaultCore, type CoreInstance } from './core/coreInstance'
// parseToolCallArgs 住在 modelTurn（纯 helper 层）—— 主循环与 subagents 的第二条工具循环
// 必须共用同一份「坏 JSON 不执行工具」的判据，各抄一份迟早会漂移。
import { buildSystemItem, buildTurnTools, narrowToolCalls, parseToolCallArgs } from './modelTurn'
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
import { compactionPlugin, type CompactionRequestDraft } from './core/plugins/compactionPlugin'
import { migrationPlugin } from './core/plugins/migrationPlugin'
import {
  finishReasonPlugin,
  FINISH_REASON_ITEM_NOTICES,
  isAbnormalFinishReason,
  type AbnormalFinishReason,
  type FinishReasonTurnEndEvent,
} from './core/plugins/finishReasonPlugin'
import {
  loopGuardPlugin,
  type LoopGuardTurnEndDecision,
  type LoopGuardTurnEndEvent,
} from './core/plugins/loopGuardPlugin'
import { formatSubagentTranscript } from '../subagents/distill'
import { ROOT_AGENT_PATH } from '../subagents/path'
import { createDelegateAgentRuntime } from '../subagents/runtime'
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

// 循环上限保护（TK8）：防止 model 无限请求工具 / 死循环，超限降级为 error。
const MAX_AGENT_TURNS = 12
// LOOP_DETECTION_THRESHOLD / LOOP_DETECTED_ERROR 已随循环检测搬进 loopGuardPlugin（Core 抽离 Stage 2a）。
const STREAM_UPDATE_INTERVAL_MS = 50
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

// finish_reason 异常三态的 type + 用户可见文案（三份 Record）已搬进 finishReasonPlugin（Core 抽离
// Stage 2a），本文件改从插件 import：AbnormalFinishReason（下方 LABEL_TAGS 的键类型）/ FINISH_REASON_ERRORS
// （run.error 文案，现由 onTurnEnd 决策 decision.reason 回传，loop 不再直接索引）/ FINISH_REASON_ITEM_NOTICES
// （Case A 流式标注，loop 侧 finalize 仍要用，故 import）/ FINISH_REASON_STANDALONE_NOTICES（Case B 非流式
// 独立标注，只插件内部用）。本文件只保留 loop 收尾自用的 FINISH_REASON_LABEL_TAGS —— 它不在迁移清单
// （仅 commitTurn 的 label 前缀用），故需 import AbnormalFinishReason 给它做 Record 键类型。

// checkpoint label 前缀 —— 让 CheckpointBar 上这一轮一眼就和成功轮区分开（label 同样落盘）。
const FINISH_REASON_LABEL_TAGS: Record<AbnormalFinishReason, string> = {
  length: '[截断] ',
  content_filter: '[已拦截] ',
  insufficient_system_resource: '[已中断] ',
}

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
  return attrs
}

function valueKind(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function tracePreview(value: unknown, limit = 500): string {
  return truncatePayload(value, limit)
}

function llmTracePreview(value: unknown): string {
  return truncatePayload(value, LLM_TRACE_PREVIEW_LIMIT, LLM_TRACE_PREVIEW_OPTIONS)
}

function stringForStats(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

// 工具调用签名规范化（isPlainRecord / normalizeForSignature / normalizedArgsSignature /
// toolCallSignature）已随循环检测搬进 loopGuardPlugin（Core 抽离 Stage 2a）。tracePreview 仍留在本文件
// （工具执行 trace 的 argsPreview / resultPreview 还在用），插件那边是逐字复制的一份、非搬走。

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

function systemInjectionSummary(content: string): string {
  const skillLine = content.split('\n').find((line) => line.startsWith('已加载 skills：'))
  return skillLine ?? compactTranscriptText(content)
}

function toolNames(tools: ModelFunctionTool[]): string[] {
  return tools.map((tool) => tool.function.name)
}

function toolManifestSummary(tools: ModelFunctionTool[]): string {
  const names = toolNames(tools)
  return compactTranscriptText(`暴露 ${tools.length} 个工具：${names.join('、') || '无'}`)
}

function emptyRoleStats() {
  return { count: 0, chars: 0, estimatedTokens: 0 }
}

function usageStats(usage: ModelChatResponse['usage']): ContextUsageStats | undefined {
  const stats: ContextUsageStats = {}
  if (typeof usage?.prompt_tokens === 'number') stats.promptTokens = usage.prompt_tokens
  if (typeof usage?.completion_tokens === 'number') stats.completionTokens = usage.completion_tokens
  if (typeof usage?.total_tokens === 'number') stats.totalTokens = usage.total_tokens
  return Object.keys(stats).length > 0 ? stats : undefined
}

function buildContextStatsSnapshot(args: {
  runId: string
  turnId: string
  llmTurn: number
  vendor: string
  model: string
  messages: ModelItem[]
  tools: ModelFunctionTool[]
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
    roles,
    toolNames: toolNames(args.tools),
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
    attrs: { ...baseAttrs, result_kind: 'error', result: { error: result.error }, error: result.error },
    err: result.error,
  }
}

// stale-run 守卫：会话仍登记，且该会话当前 run 就是本次 runId（未被新 run 顶掉）。
// core 无默认值：由 runToolLoop 逐处显式传（编译期堵住漏穿）。
function isCurrentRun(id: string, runId: string, core: CoreInstance): boolean {
  if (!core.rootStore.getter(sessionsAtom)[id]) return false
  return core.getSessionStore(id).store.getter(runAtom)?.runId === runId
}

// 给某个 tool_call 回填一条 ToolItem（tool result）。循环里逐个工具、以及确认恢复时执行完危险工具都用它。
function appendToolResult(id: string, toolCallId: string, content: string, core: CoreInstance): void {
  appendItem(id, {
    id: newId(),
    createdAt: Date.now(),
    item: { role: 'tool', tool_call_id: toolCallId, content },
  }, core)
}

// 把一个 ToolResult 映射成回给 model 的 tool-result JSON 并回填（pause 不走这里，另行处理）。
function appendMappedToolResult(id: string, toolCallId: string, result: ToolResult, core: CoreInstance): void {
  if ('pause' in result) {
    // 防御：正常路径不会到这（pause 另行拦截）。万一发生，回个 error 别 orphan。
    appendToolResult(id, toolCallId, JSON.stringify({ error: 'unexpected pause' }), core)
  } else if (result.ok) {
    const data = result.data ?? { ok: true }
    // 有 warning（参数被 schema 钳位过）时包一层带给 model；无 warning 时形状与既有完全一致。
    appendToolResult(
      id,
      toolCallId,
      JSON.stringify(result.warnings?.length ? { data, warnings: result.warnings } : data),
      core,
    )
  } else {
    appendToolResult(id, toolCallId, JSON.stringify({ error: result.error }), core)
  }
}

function assistantItemFromMessage(
  msg: ModelResponseMessage | undefined,
  content: string | null,
  toolCalls?: AssistantItem['tool_calls'],
): AssistantItem {
  const item: AssistantItem = {
    role: 'assistant',
    content,
  }
  const reasoningContent = msg?.reasoning_content
  if (reasoningContent) item.reasoning_content = reasoningContent
  if (toolCalls && toolCalls.length > 0) item.tool_calls = toolCalls
  return item
}

function createAssistantStreamWriter(id: string, runId: string, signal: AbortSignal, core: CoreInstance) {
  let assistantItemId: string | undefined
  let content = ''
  let reasoningContent = ''
  let lastFlushAt = 0

  function canWrite(ignoreAbort = false): boolean {
    return (ignoreAbort || !signal.aborted) && isCurrentRun(id, runId, core)
  }

  function currentMessage(): ModelResponseMessage {
    return {
      role: 'assistant',
      content,
      reasoning_content: reasoningContent || null,
    }
  }

  function flush(force = false): void {
    if (!content.trim() || !canWrite()) return
    const now = Date.now()
    const item = assistantItemFromMessage(currentMessage(), content)

    if (!assistantItemId) {
      assistantItemId = newId()
      appendItem(id, { id: assistantItemId, createdAt: now, pending: true, item }, core)
      lastFlushAt = now
      return
    }

    if (!force && now - lastFlushAt < STREAM_UPDATE_INTERVAL_MS) return
    updateItem(id, assistantItemId, { pending: true, item }, core)
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
      if (!assistantItemId || !canWrite()) return assistantItemId
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
      return assistantItemId
    },
    finishPending(): void {
      if (assistantItemId && canWrite(true)) updateItem(id, assistantItemId, { pending: false }, core)
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
  const items = core.getSessionStore(id).store.getter(itemsAtom)
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
// resume 时为暂停前的原始提问）。用于按触发词选 skill 组 system、以及 checkpoint 摘要。
function latestUserInput(id: string, core: CoreInstance): string {
  const first = currentTurnItems(id, core)[0]?.item
  return first?.role === 'user' ? first.content : ''
}

// TK7「已回答」守卫判定：本轮 items 里是否已有「ask_user 的 ToolItem 回填」——
// 即某条 assistant.tool_calls 里 name==='ask_user_question' 的 id，已被某条 role:'tool' 回填。
// 命中说明用户答案已提供过（resume 已续跑），此时 model 再要求提问不应再暂停（防死循环）。
function askAlreadyAnswered(id: string, core: CoreInstance): boolean {
  const turn = currentTurnItems(id, core)
  const askIds = new Set<string>()
  for (const { item } of turn) {
    if (item.role === 'assistant' && item.tool_calls) {
      for (const toolCall of item.tool_calls) {
        if (toolCall.function.name === 'ask_user_question') askIds.add(toolCall.id)
      }
    }
  }
  if (askIds.size === 0) return false
  return turn.some((it) => it.item.role === 'tool' && askIds.has(it.item.tool_call_id))
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
  appendItem(id, { id: userItemId, createdAt: Date.now(), item: { role: 'user', content: input } }, core)
  setRun(id, { runId, status: 'running' }, core)

  // 与 resume 复用同一循环入口（此时最后一条 user 就是刚 append 的 input，行为与旧版等价）。
  // core 已随 opts 透传（{ ...opts } 含 opts.core），runToolLoop 内部会 opts.core ?? defaultCore 解析同一实例。
  await runToolLoop(id, runId, { ...opts, traceSpan: rootSpan, turnId: userItemId })
}

// 简介：多轮 lazy-tool 循环入口（T-6/T-7 复用）—— 不 append user、不 setRun，
//   假定调用方（runSession 起新 run / resumeWithAnswers 续 pending run）已备好 items 与 run。
// 详情：组 system（不入库，按本轮起头 user 选 skill）→ 多轮循环：每轮重发
//   [system, ...items] + [request_tool_schema, ...visible]，按响应有无 tool_calls 分流：
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

  const turnId = opts.turnId ?? currentTurnItems(id, core)[0]?.id ?? newId()
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

  // 简介：把本轮收进一个 checkpoint 并落盘（TK9 + D-4 持久化接线，fire-and-forget/DK2）。
  // 详情：★ 这是整个 run 唯一的持久化入口 ★ —— itemsAtom 本身不持久化，刷新后全靠 checkpoint
  //   恢复。所以任何「已经往 itemsAtom 写过东西、且不会再续跑」的终止路径都必须调它一次，
  //   否则丢的不只是模型那半截回复，连用户自己发出去的那条 user 消息都会一起蒸发。
  //   触顶截断/循环/超轮数这几种异常收尾的文本通常仍然有用，落盘后 run 状态另置 error 即可。
  //   刻意【不】给 stopped（用户主动停）与 waiting_* （暂停中、续跑时才收尾）路径调用。
  //   labelTag：异常收尾时给 checkpoint label 加的前缀（如 '[截断] '）。label 会落盘，是「刷新
  //   之后仍然看得出这一轮不正常」的另一半（另一半是 assistant 正文里的系统标注）。正常轮不传。
  const commitTurn = (labelTag = ''): void => {
    // stale-run 守卫：被新 run 顶掉后不得再往（已属于新 run 的）会话里塞旧 checkpoint。
    if (!isCurrentRun(id, runId, core)) return
    commitCheckpoint(id, `${labelTag}${input.slice(0, 20)}`, core)
    const checkpoints = core.getSessionStore(id).store.getter(checkpointsAtom)
    const committed = checkpoints[checkpoints.length - 1]
    if (committed) {
      traceEvent('checkpoint.commit', { turnIndex: committed.turnIndex, items_count: committed.items.length })
      persistCheckpoint(id, committed)
    }
    persistSessions()
  }

  // system 只用于请求、不入库（TK4）：按输入选 skill，system 只列已加载 skill 名。
  const system = buildSystemItem(input)
  addTranscriptEvent(id, 'system_injection', '注入 system', systemInjectionSummary(system.content), system.content, core)
  traceEvent('llm.system_injected', { system_chars: system.content.length })
  // thinking：状态层 boolean → 线协议 { type:'enabled'|'disabled' }。区分三态（codex P2）：
  //   undefined → 不传（用服务端默认）；true → enabled；false → disabled（显式关思考，
  //   否则 reasoning-默认-开 的 provider 会无视用户的关闭设置）。
  const thinking =
    meta.settings.thinking === undefined
      ? undefined
      : ({ type: meta.settings.thinking ? 'enabled' : 'disabled' } as const)
  const callOptions = { apiKey: opts.apiKey, signal: opts.signal, fetchImpl: opts.fetchImpl }
  const delegateRuntime = createDelegateAgentRuntime({
    sessionId: id,
    runId,
    settings: meta.settings,
    apiKey: opts.apiKey,
    signal: opts.signal,
    fetchImpl: opts.fetchImpl,
  })
  const rootTranscript = () => formatSubagentTranscript([system, ...currentTurnItems(id, core).map((it) => it.item)])

  // 本轮可见工具（懒加载累积）：只有出现在此的 schema 才暴露给下一轮 model（TK3）。
  let visible: LoadedTool[] = []
  // 循环检测的跨轮累计状态（原 consecutiveToolOnlyTurns / repeatedToolSignatures）已随 loopGuardPlugin
  //   搬进插件的 per-run 闭包（每次 assemblePlugins 一份全新计数，天然按 run 隔离，无需在此手持）。

  // Core 抽离：运行时句柄 CoreCtx（PX1）—— 带【真】traceEvent（复用上面的闭包，与 TraceEventFn 逐字
  //   同形），供 transformContext（压缩）/ onTurnEnd（finish_reason 三态 / 循环检测）等循环内 hook 用。
  //   插件发出的 'llm.context_compacted' 等自动带上同一份 baseTraceAttrs（sessionId/runId/turnId），与旧
  //   内联发法逐字一致。store 取本会话 einfach store，root 取 rootStore；isCurrent() 由 makeCoreCtx 闭合到
  //   本次 (root, store, id, runId)，与本文件私有 isCurrentRun(id, runId) 等价（异步插件写回前自查用）。
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
      const { callId, toolName, args } = opts.resumeToolCall
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
        attrs: { sessionId: id, runId, turnId, toolName, callId, resumed: true, args },
      })
      let result: ToolResult
      try {
        result = await core.tools.run(toolName, args, ctx)
        const traced = toolResultTrace(result, args)
        endSpan(toolSpan, traced.status, traced.attrs, traced.err)
      } catch (err) {
        endSpan(toolSpan, abortStatus(opts.signal, err), { error: safeErrorMessage(err) }, err)
        throw err
      } finally {
        removeToolActivity(id, callId, core)
      }
      // TK8 每步守卫：await 后写回前查会话还在、且仍是本次 run；esc 中断则收成 stopped。
      if (!isCurrentRun(id, runId, core)) {
        finishTrace('cancelled', 'agent.stale_run', { reason: 'stale_run' })
        return
      }
      if (opts.signal.aborted) {
        if (isCurrentRun(id, runId, core)) {
          patchRun(id, { status: 'stopped' }, core)
          finishTrace('cancelled', 'agent.stopped', { reason: 'aborted' })
        }
        return
      }
      // 危险工具不该返回 pause；即便返回也按 error 回填（appendMappedToolResult 内已防御）。
      appendMappedToolResult(id, callId, result, core)
    }

    for (let turn = 0; turn < MAX_AGENT_TURNS; turn += 1) {
      // 每轮重新 map itemsAtom（含上一轮 append 的 assistant/tool items），TK1。
      const items = core.getSessionStore(id).store.getter(itemsAtom)
      const rawMessages = [system, ...items.map((it) => it.item)]
      // TP3：注入运行环境 —— web 下 isTauri() 为假，server 工具不进本轮 manifest。
      // 必须先算 tools：它的 JSON 也吃上下文额度，要从压缩预算里先扣掉。
      // 传本实例的 registry：request_tool_schema 的 enum 才会枚举【本 core】可懒加载的工具，
      // 而非模块级 defaultCore.tools（隔离实例装自定义工具集时的正确性，codex review [P1]）。
      const tools = buildTurnTools(visible, isTauri(), { registry: core.tools })
      const names = toolNames(tools)

      // ── CC 接入：组请求体前经 transformContext hook 压一次上下文（compactionPlugin，PX3）。
      // ★ 压缩结果【只进请求体】—— 绝不写回 itemsAtom、不进 commitCheckpoint、不持久化。
      //   itemsAtom 是唯一真相源，压缩只是每轮请求时的一次性投影；写回会永久破坏历史、让
      //   revert 拿到被摘要过的快照。每轮都重压一次（items 每轮在变），compactContext 幂等。
      //   draft 是本轮请求体的一次性可变投影：把 rawMessages / tools / llmTurn 挂进去，hook
      //   就地改 draft.messages 并写回 draft.compaction —— 读回即得与旧内联 compactContext 逐字
      //   等价的结果（预算/摘要/降级全在插件里，vendor/model/max_tokens 由插件从 ctx.root 取）。
      //   压缩发出的 'llm.context_compacted' / 'llm.context_over_budget' 已由插件经 ctx.traceEvent
      //   发好（attr 逐字对齐旧代码），loop 这里不再重发（重发即双发）。
      const draft: CompactionRequestDraft = { messages: rawMessages, tools, llmTurn: turn + 1 }
      await hooks.transformContext?.(ctx, draft)
      // compactionPlugin 是 Stage 1 唯一的 transformContext 注册者，draft.compaction 必被写回；
      // messages 与 compaction 局部变量刻意沿用旧名——下方 contextStats / requestBase / llmSpan
      // attrs 一个字都不用改，把集成 diff 压到最小。
      const messages = draft.messages
      const compaction = draft.compaction!
      const contextStats = buildContextStatsSnapshot({
        runId,
        turnId,
        llmTurn: turn + 1,
        vendor: meta.settings.vendor,
        model: meta.settings.model,
        messages,
        tools,
      })
      setContextStats(id, contextStats, core)
      addTranscriptEvent(id, 'tool_manifest', '注入 tools', toolManifestSummary(tools), tools, core)
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
      })
      // 压缩可见性事件（'llm.context_compacted' / 'llm.context_over_budget'）已由 compactionPlugin
      // 在 transformContext 里经 ctx.traceEvent 发出——attr 名 / 值逐字对齐旧内联代码（含
      // context_window_tk / budget_source / _tk 后缀那套避 redact 的口径）。这里【不能再发一遍】，
      // 否则每次压缩都会双发同名事件。两个事件独立、不互斥（压过必发前者；压完仍超再发后者）。

      // 按 vendor 收窄 settings 后调 model（流式；最终仍归一成完整 ModelChatResponse）。
      const streamWriter = createAssistantStreamWriter(id, runId, opts.signal, core)
      let res: ModelChatResponse
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
      const requestPreviewBody = {
        ...requestBase,
        reasoning_effort: meta.settings.reasoning_effort,
      }
      const llmSpan = startSpan('llm.chat', {
        kind: 'llm',
        parent: traceSpan,
        attrs: {
          sessionId: id,
          runId,
          turnId,
          vendor: meta.settings.vendor,
          model: meta.settings.model,
          messages_count: messages.length,
          tools_count: tools.length,
          estimated_context_tokens: contextStats.estimatedTokens,
          context_chars: contextStats.totalChars,
          tools_chars: contextStats.toolsChars,
          context_compacted: compaction.compacted,
          context_within_budget: compaction.withinBudget,
          requestPreview: llmTracePreview(requestPreviewBody),
        },
      })
      try {
        if (meta.settings.vendor === 'glm') {
          const s = meta.settings
          const requestBody: GlmChatRequest = { ...requestBase, reasoning_effort: s.reasoning_effort }
          res = await streamGlm(requestBody, callOptions, { onDelta: streamWriter.onDelta })
        } else {
          const s = meta.settings
          const requestBody: DeepSeekChatRequest = { ...requestBase, reasoning_effort: s.reasoning_effort }
          res = await streamDeepSeek(requestBody, callOptions, { onDelta: streamWriter.onDelta })
        }
      } catch (err) {
        endSpan(llmSpan, abortStatus(opts.signal, err), { error: safeErrorMessage(err) }, err)
        throw err
      }
      const choice = res.choices?.[0]
      const msg = choice?.message
      const toolCalls = narrowToolCalls(msg?.tool_calls)
      endSpan(llmSpan, 'ok', {
        finish_reason: choice?.finish_reason ?? null,
        tool_calls_count: toolCalls.length,
        content_chars: responseChars(msg?.content),
        reasoning_chars: responseChars(msg?.reasoning_content),
        response_id: res.id,
        response_model: res.model,
        responsePreview: llmTracePreview(res),
        ...usageTraceAttrs(res.usage),
      })

      // TK8 每步守卫：写回前再查会话还在、且仍是本次 run（异步期间可能被删/被顶掉）。
      if (!isCurrentRun(id, runId, core)) {
        finishTrace('cancelled', 'agent.stale_run', { reason: 'stale_run' })
        return
      }
      // esc race：fetch 在 abort 前已返回但 signal 已中断 → stopped，不写回。
      if (opts.signal.aborted) {
        streamWriter.finishPending()
        if (isCurrentRun(id, runId, core)) patchRun(id, { status: 'stopped' }, core)
        finishTrace('cancelled', 'agent.stopped', { reason: 'aborted' })
        return
      }

      setContextStats(id, {
        ...contextStats,
        usage: usageStats(res.usage),
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
      // 收敛成一个「已收窄的异常 finishReason」：非 undefined 即「本轮要因 finish_reason 终止」，与旧
      //   else-if 逐字等价（length+tool_calls 已被上面拦走、不落这里）。isAbnormalFinishReason 收窄后既能
      //   当布尔用、又能索引 FINISH_REASON_ITEM_NOTICES / FINISH_REASON_LABEL_TAGS。
      const abnormalFinish: AbnormalFinishReason | undefined =
        isAbnormalFinishReason(finishReason) && !(finishReason === 'length' && toolCalls.length > 0)
          ? finishReason
          : undefined
      // Case A（流式已建条目）的系统标注必须由 loop 侧在 onTurnEnd【之前】finalize 追加 —— 完整正文只
      //   活在 streamWriter 闭包里（flush 有 50ms 节流），插件从 store 只能拿到最后一次节流快照，自己拼
      //   标注会把末尾那截文字顶掉（这就是「流式风险挡在插件外」）。传 toolCalls=undefined：assistantItem-
      //   FromMessage 只看第三参、不回落 msg.tool_calls，绝不落没有 result 的孤儿 tool_calls（本分支要终止、
      //   不执行工具）；finalize 在 !assistantItemId（Case B 非流式）时直接 return，与插件补条目不冲突。
      if (abnormalFinish) {
        streamWriter.finalize(msg, undefined, FINISH_REASON_ITEM_NOTICES[abnormalFinish])
      }
      // onTurnEnd fan-out：loopGuard（跨轮重复工具调用累计 + 命中即中止）先、finishReason（异常三态中止 +
      //   补 Case B 非流式标注条目）后，首个 stop 胜且短路——复刻旧代码「循环检测 block 在 finish_reason
      //   block 之前」的评估序。loopGuard 每轮都要累计/清零，故 onTurnEnd 无条件每轮调一次。两个插件的私有
      //   扩展字段（assistantHasContent / msg+hasStreamedItem）经交叉类型一次挂上；onTurnEnd 是循环内 await
      //   收尾点，命中收尾里的 commitTurn/patchRun 各自带 isCurrentRun 守卫（stale/ghost 不写）。
      const turnEndEvent: LoopGuardTurnEndEvent & FinishReasonTurnEndEvent = {
        finishReason,
        toolCalls,
        assistantHasContent,
        msg,
        hasStreamedItem: streamWriter.hasItem(),
      }
      const decision = (await hooks.onTurnEnd?.(ctx, turnEndEvent)) as LoopGuardTurnEndDecision | undefined
      if (decision?.stop) {
        if (abnormalFinish) {
          // finish_abnormal 收尾（条目已由 finishReasonPlugin 在 onTurnEnd 内按 Case A/B 落好）：★ 照常
          //   commitCheckpoint + 落盘 ★——本轮虽收成 error 但条目已进 itemsAtom，而 itemsAtom 不持久化，
          //   不落 checkpoint 用户刷新后连自己那条 user 消息都会一起蒸发。label 带 [截断]/[已拦截]/[已中断] 前缀。
          commitTurn(FINISH_REASON_LABEL_TAGS[abnormalFinish])
          if (isCurrentRun(id, runId, core)) patchRun(id, { status: 'error', error: decision.reason }, core)
          finishTrace('error', 'agent.finish_abnormal', {
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
          //   ='tool_calls'，与异常三态互斥），故 decision 必带 traceEventName/traceAttrs。
          streamWriter.finishPending()
          commitTurn()
          if (isCurrentRun(id, runId, core)) patchRun(id, { status: decision.runStatus ?? 'error', error: decision.reason }, core)
          finishTrace('error', decision.traceEventName ?? 'agent.loop_detected', decision.traceAttrs)
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
        if (!streamedAssistantItemId) {
          appendItem(id, {
            id: newId(),
            createdAt: Date.now(),
            item: assistantItemFromMessage(msg, msg?.content ?? null, toolCalls),
          }, core)
        }

        // 本批至多允许「一个」中断（ask_user 暂停 或 危险工具确认）——先记着，等同条消息里其它
        // tool_call 都补齐 result 再统一处理。否则提前 return 会漏掉其余 tool_call 的 tool 消息，
        // resume 重发被 OpenAI 兼容接口拒（每个 tool_call 必须有匹配 result，codex P2）。
        let pauseCall: { callId: string; payload: unknown } | undefined // ask_user 暂停
        let confirmCall: PendingToolConfirmation | undefined // S4-B 危险工具确认
        // 已有任一中断挂起 → 后来的中断只能退化成「已在等待」的占位 error result，避免 orphan。
        const interruptPending = () => pauseCall !== undefined || confirmCall !== undefined

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
            appendToolResult(id, toolCall.id, JSON.stringify(resultPayload), core)
            continue
          }
          const args = parsedArgs.args
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
            appendToolResult(id, toolCall.id, JSON.stringify(resultPayload), core)
            continue
          }

          // request_tool_schema：懒加载 schema+guide 进 visible（累计已载写回 run），回 loadSchema JSON。同步，无需守卫。
          if (name === 'request_tool_schema') {
            const toolName = typeof args.toolName === 'string' ? args.toolName : ''
            const schemaSpan = startSpan('request_tool_schema', {
              kind: 'internal',
              parent: traceSpan,
              attrs: { sessionId: id, runId, turnId, toolName, callId: toolCall.id, args },
            })
            // ensureToolLoaded 已穿 core（toolLoading.ts）：读 core.tools + patchRun(..., core)，
            //   与紧邻的 core.tools.loadSchema 同源。默认 core=defaultCore 时行为零变化，隔离实例走本核。
            visible = ensureToolLoaded(id, visible, toolName, core)
            const schema = core.tools.loadSchema(toolName)
            const found = schema !== undefined
            const resultPayload = schema ?? { error: 'unknown' }
            traceEvent('tool.schema_requested', { toolName, callId: toolCall.id, found, args, result: resultPayload })
            endSpan(schemaSpan, found ? 'ok' : 'error', { found, result: resultPayload })
            appendToolResult(id, toolCall.id, JSON.stringify(schema ?? { error: 'unknown' }), core)
            continue
          }

          // S4-B 危险工具确认门：变更类 server 工具执行前须用户确认（除非本 session 已一律允许）。
          //   命中即延后为 confirmCall（不建 ctx、不执行、不回填 result，留给 confirmTool 恢复时处理）。
          //   isToolAlwaysAllowed 已穿 core（transientAtoms）：读 core 的「一律允许」集合，隔离实例走本核。
          if (isDangerousTool(name) && !isToolAlwaysAllowed(id, name, core)) {
            if (interruptPending()) {
              // 同批已有一个待确认/待暂停 → 该危险工具先回占位 error（resume 只处理一个中断）。
              appendToolResult(id, toolCall.id, JSON.stringify({ error: '已有待确认的工具调用，请先处理' }), core)
            } else {
              confirmCall = { callId: toolCall.id, toolName: name, args }
            }
            continue
          }

          // 其它工具：建 ctx（副作用白名单）→ 经工厂统一分发 → 拿 ToolResult。
          const ctx = buildToolContext({
            sessionId: id,
            runId,
            signal: opts.signal,
            callId: toolCall.id,
            toolName: name,
            toolArgs: args,
            agentPath: ROOT_AGENT_PATH,
            getParentTranscript: rootTranscript,
            delegateRuntime,
            core,
          })
          const toolSpan = startSpan('tool.call', {
            kind: 'tool',
            parent: traceSpan,
            attrs: { sessionId: id, runId, turnId, toolName: name, callId: toolCall.id, args },
          })
          let result: ToolResult
          try {
            result = await core.tools.run(name, args, ctx)
            const traced = toolResultTrace(result, args)
            endSpan(toolSpan, traced.status, traced.attrs, traced.err)
          } catch (err) {
            endSpan(toolSpan, abortStatus(opts.signal, err), { error: safeErrorMessage(err) }, err)
            throw err
          } finally {
            // 无论正常返回还是 AbortError 抛出，都清掉该 tool 的进度条目 —— 否则 stop 后 UI 残留卡住的进度行（codex P2）。
            removeToolActivity(id, toolCall.id, core)
          }

          // TK8「每步不漏」：execute 可能异步且 signal 穿透其中，await 后写回前再查会话还在、且仍是本次 run；
          // 被顶掉的旧 run 不得把迟到 result 写进新 run；esc 中断则收成 stopped。
          if (!isCurrentRun(id, runId, core)) {
            finishTrace('cancelled', 'agent.stale_run', { reason: 'stale_run' })
            return
          }
          if (opts.signal.aborted) {
            if (isCurrentRun(id, runId, core)) patchRun(id, { status: 'stopped' }, core)
            finishTrace('cancelled', 'agent.stopped', { reason: 'aborted' })
            return
          }

          // 结果映射（§4）：pause 延后处理；ok → data JSON；error → {error} JSON（TK6，不打断）。
          if ('pause' in result) {
            if (interruptPending()) {
              // 已有中断（ask_user/危险工具）→ 这个多余的 pause 补个 result，别让它 orphan。
              appendToolResult(id, toolCall.id, JSON.stringify({ error: 'already pausing' }), core)
            } else {
              pauseCall = { callId: toolCall.id, payload: result.pause } // 不 append，留给 resume 回填
            }
          } else {
            appendMappedToolResult(id, toolCall.id, result, core)
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
          return
        }

        // 再处理 ask_user 暂停：TK7「已回答」守卫 —— resume 后本轮已回填过 ask_user 的 result
        //   → 不再暂停，回 {error:'user_answers_already_provided'} 让 model 用已给答案续跑，防死循环；
        //   否则暂停 run（waiting_user + pendingQuestion），该 tool 的 result 留给 resume 回填。
        if (pauseCall) {
          const planApproval = planApprovalPayload(pauseCall.payload)
          if (planApproval) {
            traceEvent('agent.waiting_plan_approval', { callId: pauseCall.callId, ...planApproval })
            patchRun(id, {
              status: 'waiting_plan_approval',
              pendingPlanApproval: { callId: pauseCall.callId, ...planApproval },
            }, core)
            return
          }
          if (askAlreadyAnswered(id, core)) {
            traceEvent('agent.waiting_user_skipped', { callId: pauseCall.callId, reason: 'already_answered' })
            appendToolResult(id, pauseCall.callId, JSON.stringify({ error: 'user_answers_already_provided' }), core)
          } else {
            traceEvent('agent.waiting_user', {
              callId: pauseCall.callId,
              question_count: questionCount(pauseCall.payload),
            })
            patchRun(id, { status: 'waiting_user', pendingQuestion: pauseCall.payload }, core)
            return
          }
        }

        continue
      }

      // ── 无 tool_calls：最终答案。空回复（null/空串/纯空白）当失败，不写、不 commit。
      const content = msg?.content
      if (!content || !content.trim()) {
        if (isCurrentRun(id, runId, core)) patchRun(id, { status: 'error', error: '模型返回空回复' }, core)
        finishTrace('error', 'agent.error', { error: '模型返回空回复' })
        return
      }

      if (!streamedAssistantItemId) {
        appendItem(id, {
          id: newId(),
          createdAt: Date.now(),
          item: assistantItemFromMessage(msg, content),
        }, core)
      }
      commitTurn() // TK9：一轮用户输入收尾 = 一个 checkpoint（并落盘）。
      patchRun(id, { status: 'done' }, core)
      finishTrace('ok', 'agent.done', { status: 'done' })
      return
    }

    // 循环跑满 MAX_AGENT_TURNS 仍未收尾 → 降级为 error（TK8 上限保护）。
    // 同样要落盘：跑满 12 轮意味着 itemsAtom 里已堆了大量 assistant/tool 条目，丢掉整轮
    // 代价最大（含用户那条 user 消息）。
    commitTurn()
    if (isCurrentRun(id, runId, core)) patchRun(id, { status: 'error', error: '超过最大工具轮数' }, core)
    finishTrace('error', 'agent.max_turns', { max_turns: MAX_AGENT_TURNS, error: '超过最大工具轮数' })
  } catch (err) {
    // U7 降级：被 esc 中断 → 'stopped'（仅当仍是本次 run，避免污染新 run）。
    // ★ 必须用 modelApi.isAbortError（按 name 鸭子类型），不能写 `err instanceof DOMException` ★ ——
    //   中断错误的标准形态是 DOMException('AbortError')，但 Tauri / node-fetch 等 fetch polyfill
    //   只抛一个 name==='AbortError' 的普通 Error。modelApi 那边已经按鸭子类型识别并如实透传，
    //   这边若还用 instanceof 就认不出来：用户按了停止键，run 却落成 'error' + 一段英文异常。
    //   判据必须和抛出侧（modelApi）保持同一份，否则每加一个 fetch 实现就复发一次。
    if (isAbortError(err)) {
      if (isCurrentRun(id, runId, core)) patchRun(id, { status: 'stopped' }, core)
      finishTrace('cancelled', 'agent.stopped', { reason: 'abort_error' }, err)
      return
    }
    // 其它失败 → 'error'（不抛崩 UI；仅当仍是本次 run）。
    if (isCurrentRun(id, runId, core)) {
      patchRun(id, { status: 'error', error: err instanceof Error ? err.message : String(err) }, core)
    }
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
      const finalRun = core.getSessionStore(id).store.getter(runAtom)
      if (
        !finalRun ||
        finalRun.runId !== runId ||
        finalRun.status === 'done' ||
        finalRun.status === 'stopped' ||
        finalRun.status === 'error'
      ) {
        await delegateRuntime.dispose?.()
      }
    } catch (err) {
      traceEvent('agent.dispose_failed', {
        error: safeErrorMessage(err),
        aborted: isAbortError(err) || opts.signal.aborted,
      })
    }
  }
}
