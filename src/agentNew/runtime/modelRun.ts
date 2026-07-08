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

import { isTauri } from '@tauri-apps/api/core'
import { rootStore, sessionsAtom } from '../state/rootStore'
import { getSessionStore } from '../state/sessionStore'
import { itemsAtom, runAtom, checkpointsAtom } from '../state/sessionAtoms'
import { appendItem, setRun, patchRun, updateItem } from '../state/sessionWriters'
import { commitCheckpoint } from '../state/checkpointWriters'
import { removeToolActivity, isToolAlwaysAllowed, addRuntimeTranscriptEvent } from '../state/transientAtoms'
import { isDangerousTool } from './dangerousTools'
import type { PendingToolConfirmation } from '../state/core.type'
import { persistCheckpoint, persistSessions } from './persistenceBridge'
import { streamDeepSeek, type DeepSeekChatRequest } from '../api/deepseek'
import { streamGlm, type GlmChatRequest } from '../api/glm'
import type {
  AssistantItem,
  ModelChatResponse,
  ModelFunctionTool,
  ModelResponseMessage,
  ModelStreamDelta,
} from '../api/modelApi'
import { toolRegistry } from '../tools/registry'
import type { LoadedTool, ToolResult } from '../tools/types'
import '../tools/register' // 副作用：把内置工具注册进 toolRegistry（运行时任何用工具的路径都经 modelRun）。
import { ensureToolLoaded } from './toolLoading'
import { buildToolContext } from './toolContext'
import { buildSystemItem, buildTurnTools, narrowToolCalls, safeParseArgs } from './modelTurn'
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
const LOOP_DETECTION_THRESHOLD = 3
const STREAM_UPDATE_INTERVAL_MS = 50
const LOOP_DETECTED_ERROR = '检测到重复工具调用循环'
const SHELL_TOOLS_REQUIRING_COMMAND = new Set(['shell_macos', 'shell_linux', 'shell_powershell'])
const LLM_TRACE_PREVIEW_LIMIT = 80_000
const LLM_TRACE_PREVIEW_OPTIONS = {
  stringLimit: LLM_TRACE_PREVIEW_LIMIT,
  depth: 8,
  itemLimit: 1_000,
  keyLimit: 400,
}

function abortStatus(signal: AbortSignal): Exclude<TraceStatus, 'running'> {
  return signal.aborted ? 'cancelled' : 'error'
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeForSignature(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeForSignature(item))
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeForSignature(value[key])]),
    )
  }
  return value
}

function normalizedArgsSignature(args: unknown): string {
  try {
    return JSON.stringify(normalizeForSignature(args)) ?? ''
  } catch {
    return String(args)
  }
}

function toolCallSignature(toolName: string, args: unknown): string {
  return `${toolName}:${normalizedArgsSignature(args)}`
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

function addTranscriptEvent(
  sessionId: string,
  kind: 'system_injection' | 'tool_manifest',
  title: string,
  summary: string,
  detail: unknown,
): void {
  addRuntimeTranscriptEvent(sessionId, {
    id: newId(),
    createdAt: Date.now(),
    kind,
    title,
    summary,
    detail: transcriptDetail(detail),
  })
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
function isCurrentRun(id: string, runId: string): boolean {
  if (!rootStore.getter(sessionsAtom)[id]) return false
  return getSessionStore(id).store.getter(runAtom)?.runId === runId
}

// 给某个 tool_call 回填一条 ToolItem（tool result）。循环里逐个工具、以及确认恢复时执行完危险工具都用它。
function appendToolResult(id: string, toolCallId: string, content: string): void {
  appendItem(id, {
    id: newId(),
    createdAt: Date.now(),
    item: { role: 'tool', tool_call_id: toolCallId, content },
  })
}

// 把一个 ToolResult 映射成回给 model 的 tool-result JSON 并回填（pause 不走这里，另行处理）。
function appendMappedToolResult(id: string, toolCallId: string, result: ToolResult): void {
  if ('pause' in result) {
    // 防御：正常路径不会到这（pause 另行拦截）。万一发生，回个 error 别 orphan。
    appendToolResult(id, toolCallId, JSON.stringify({ error: 'unexpected pause' }))
  } else if (result.ok) {
    appendToolResult(id, toolCallId, JSON.stringify(result.data ?? { ok: true }))
  } else {
    appendToolResult(id, toolCallId, JSON.stringify({ error: result.error }))
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

function createAssistantStreamWriter(id: string, runId: string, signal: AbortSignal) {
  let assistantItemId: string | undefined
  let content = ''
  let reasoningContent = ''
  let lastFlushAt = 0

  function canWrite(ignoreAbort = false): boolean {
    return (ignoreAbort || !signal.aborted) && isCurrentRun(id, runId)
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
      appendItem(id, { id: assistantItemId, createdAt: now, pending: true, item })
      lastFlushAt = now
      return
    }

    if (!force && now - lastFlushAt < STREAM_UPDATE_INTERVAL_MS) return
    updateItem(id, assistantItemId, { pending: true, item })
    lastFlushAt = now
  }

  return {
    onDelta(delta: ModelStreamDelta): void {
      if (typeof delta.content === 'string') content += delta.content
      if (typeof delta.reasoning_content === 'string') reasoningContent += delta.reasoning_content
      flush()
    },
    finalize(msg: ModelResponseMessage | undefined, toolCalls?: AssistantItem['tool_calls']): string | undefined {
      if (!assistantItemId || !canWrite()) return assistantItemId
      const finalContent = typeof msg?.content === 'string' ? msg.content : content
      const finalMsg: ModelResponseMessage = {
        role: 'assistant',
        content: finalContent,
        reasoning_content: msg?.reasoning_content ?? (reasoningContent || null),
        tool_calls: msg?.tool_calls,
      }
      updateItem(id, assistantItemId, {
        pending: false,
        item: assistantItemFromMessage(finalMsg, finalContent, toolCalls),
      })
      return assistantItemId
    },
    finishPending(): void {
      if (assistantItemId && canWrite(true)) updateItem(id, assistantItemId, { pending: false })
    },
  }
}

// 取「本轮」——itemsAtom 里最后一条 user 之后的 items（含那条 user）。
// 一轮以 user 起头；resume 回填的是 ToolItem、不 append user echo，故 resume 续跑的 items
// 仍归上一条 user 那一轮 —— 天然把守卫/输入推断限定在当前这轮，不误伤历史轮。
function currentTurnItems(id: string) {
  const items = getSessionStore(id).store.getter(itemsAtom)
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
function latestUserInput(id: string): string {
  const first = currentTurnItems(id)[0]?.item
  return first?.role === 'user' ? first.content : ''
}

// TK7「已回答」守卫判定：本轮 items 里是否已有「ask_user 的 ToolItem 回填」——
// 即某条 assistant.tool_calls 里 name==='ask_user_question' 的 id，已被某条 role:'tool' 回填。
// 命中说明用户答案已提供过（resume 已续跑），此时 model 再要求提问不应再暂停（防死循环）。
function askAlreadyAnswered(id: string): boolean {
  const turn = currentTurnItems(id)
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
  opts: { signal: AbortSignal; apiKey: string; fetchImpl?: typeof fetch },
): Promise<void> {
  const runId = newId()
  const userItemId = newId()
  const meta = rootStore.getter(sessionsAtom)[id]
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
  appendItem(id, { id: userItemId, createdAt: Date.now(), item: { role: 'user', content: input } })
  setRun(id, { runId, status: 'running' })

  // 与 resume 复用同一循环入口（此时最后一条 user 就是刚 append 的 input，行为与旧版等价）。
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
  },
): Promise<void> {
  const traceKey = runTraceKey(id, runId)
  // ghost guard：会话未登记 → 直接返回（不发请求、不写入）。同时收窄 meta 供后续取 settings。
  const meta = rootStore.getter(sessionsAtom)[id]
  if (!meta) {
    const missingSpan = opts.traceSpan ?? getActiveSpan(traceKey)
    if (missingSpan) {
      addEvent('agent.session_missing', { span: missingSpan, attrs: { sessionId: id, runId } })
      endSpan(missingSpan, 'cancelled', { reason: 'session_missing' })
      clearActiveSpan(traceKey, missingSpan)
    }
    return
  }

  const turnId = opts.turnId ?? currentTurnItems(id)[0]?.id ?? newId()
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
  const input = latestUserInput(id)

  // system 只用于请求、不入库（TK4）：按输入选 skill，system 只列已加载 skill 名。
  const system = buildSystemItem(input)
  addTranscriptEvent(id, 'system_injection', '注入 system', systemInjectionSummary(system.content), system.content)
  traceEvent('llm.system_injected', { system_chars: system.content.length })
  // thinking：状态层 boolean → 线协议 { type:'enabled'|'disabled' }。区分三态（codex P2）：
  //   undefined → 不传（用服务端默认）；true → enabled；false → disabled（显式关思考，
  //   否则 reasoning-默认-开 的 provider 会无视用户的关闭设置）。
  const thinking =
    meta.settings.thinking === undefined
      ? undefined
      : ({ type: meta.settings.thinking ? 'enabled' : 'disabled' } as const)
  const callOptions = { apiKey: opts.apiKey, signal: opts.signal, fetchImpl: opts.fetchImpl }

  // 本轮可见工具（懒加载累积）：只有出现在此的 schema 才暴露给下一轮 model（TK3）。
  let visible: LoadedTool[] = []
  let consecutiveToolOnlyTurns = 0
  const repeatedToolSignatures = new Map<string, number>()

  try {
    // S4-B 确认「允许」恢复：先把被确认的危险工具执行、回填结果，再进正常多轮循环。
    //   暂停时该 tool_call 的 result 被特意留空（同批其它 tool_call 已补齐），这里补上它，序列才合法。
    if (opts.resumeToolCall) {
      const { callId, toolName, args } = opts.resumeToolCall
      const ctx = buildToolContext({ sessionId: id, runId, signal: opts.signal, callId, toolName })
      const toolSpan = startSpan('tool.call', {
        kind: 'tool',
        parent: traceSpan,
        attrs: { sessionId: id, runId, turnId, toolName, callId, resumed: true, args },
      })
      let result: ToolResult
      try {
        result = await toolRegistry.run(toolName, args, ctx)
        const traced = toolResultTrace(result, args)
        endSpan(toolSpan, traced.status, traced.attrs, traced.err)
      } catch (err) {
        endSpan(toolSpan, abortStatus(opts.signal), { error: safeErrorMessage(err) }, err)
        throw err
      } finally {
        removeToolActivity(id, callId)
      }
      // TK8 每步守卫：await 后写回前查会话还在、且仍是本次 run；esc 中断则收成 stopped。
      if (!isCurrentRun(id, runId)) {
        finishTrace('cancelled', 'agent.stale_run', { reason: 'stale_run' })
        return
      }
      if (opts.signal.aborted) {
        if (isCurrentRun(id, runId)) {
          patchRun(id, { status: 'stopped' })
          finishTrace('cancelled', 'agent.stopped', { reason: 'aborted' })
        }
        return
      }
      // 危险工具不该返回 pause；即便返回也按 error 回填（appendMappedToolResult 内已防御）。
      appendMappedToolResult(id, callId, result)
    }

    for (let turn = 0; turn < MAX_AGENT_TURNS; turn += 1) {
      // 每轮重新 map itemsAtom（含上一轮 append 的 assistant/tool items），TK1。
      const items = getSessionStore(id).store.getter(itemsAtom)
      const messages = [system, ...items.map((it) => it.item)]
      // TP3：注入运行环境 —— web 下 isTauri() 为假，server 工具不进本轮 manifest。
      const tools = buildTurnTools(visible, isTauri())
      const names = toolNames(tools)
      addTranscriptEvent(id, 'tool_manifest', '注入 tools', toolManifestSummary(tools), tools)
      traceEvent('llm.tools_injected', {
        tools_count: tools.length,
        tool_names: names.join(','),
      })

      // 按 vendor 收窄 settings 后调 model（流式；最终仍归一成完整 ModelChatResponse）。
      const streamWriter = createAssistantStreamWriter(id, runId, opts.signal)
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
        endSpan(llmSpan, abortStatus(opts.signal), { error: safeErrorMessage(err) }, err)
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
      if (!isCurrentRun(id, runId)) {
        finishTrace('cancelled', 'agent.stale_run', { reason: 'stale_run' })
        return
      }
      // esc race：fetch 在 abort 前已返回但 signal 已中断 → stopped，不写回。
      if (opts.signal.aborted) {
        streamWriter.finishPending()
        if (isCurrentRun(id, runId)) patchRun(id, { status: 'stopped' })
        finishTrace('cancelled', 'agent.stopped', { reason: 'aborted' })
        return
      }

      const assistantHasContent = typeof msg?.content === 'string' && msg.content.trim().length > 0
      const isToolOnlyTurn =
        choice?.finish_reason === 'tool_calls' && toolCalls.length > 0 && !assistantHasContent
      let loopDetected:
        | { toolName: string; callId: string; args: Record<string, unknown>; repeatedCount: number }
        | undefined
      if (isToolOnlyTurn) {
        consecutiveToolOnlyTurns += 1
        const seenThisTurn = new Set<string>()
        for (const toolCall of toolCalls) {
          const args = safeParseArgs(toolCall.function.arguments)
          const signature = toolCallSignature(toolCall.function.name, args)
          if (seenThisTurn.has(signature)) continue
          seenThisTurn.add(signature)
          const repeatedCount = (repeatedToolSignatures.get(signature) ?? 0) + 1
          repeatedToolSignatures.set(signature, repeatedCount)
          if (!loopDetected && repeatedCount >= LOOP_DETECTION_THRESHOLD) {
            loopDetected = {
              toolName: toolCall.function.name,
              callId: toolCall.id,
              args,
              repeatedCount,
            }
          }
        }
      } else {
        consecutiveToolOnlyTurns = 0
        repeatedToolSignatures.clear()
      }

      if (loopDetected) {
        streamWriter.finishPending()
        const attrs: TraceAttributes = {
          loop_detected: true,
          toolName: loopDetected.toolName,
          callId: loopDetected.callId,
          argsPreview: tracePreview(loopDetected.args),
          repeated_count: loopDetected.repeatedCount,
          consecutive_tool_turns: consecutiveToolOnlyTurns,
          threshold: LOOP_DETECTION_THRESHOLD,
          error: LOOP_DETECTED_ERROR,
        }
        if (isCurrentRun(id, runId)) patchRun(id, { status: 'error', error: LOOP_DETECTED_ERROR })
        finishTrace('error', 'agent.loop_detected', attrs)
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
          })
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
          const args = safeParseArgs(toolCall.function.arguments)
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
            appendToolResult(id, toolCall.id, JSON.stringify(resultPayload))
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
            visible = ensureToolLoaded(id, visible, toolName)
            const schema = toolRegistry.loadSchema(toolName)
            const found = schema !== undefined
            const resultPayload = schema ?? { error: 'unknown' }
            traceEvent('tool.schema_requested', { toolName, callId: toolCall.id, found, args, result: resultPayload })
            endSpan(schemaSpan, found ? 'ok' : 'error', { found, result: resultPayload })
            appendToolResult(id, toolCall.id, JSON.stringify(schema ?? { error: 'unknown' }))
            continue
          }

          // S4-B 危险工具确认门：变更类 server 工具执行前须用户确认（除非本 session 已一律允许）。
          //   命中即延后为 confirmCall（不建 ctx、不执行、不回填 result，留给 confirmTool 恢复时处理）。
          if (isDangerousTool(name) && !isToolAlwaysAllowed(id, name)) {
            if (interruptPending()) {
              // 同批已有一个待确认/待暂停 → 该危险工具先回占位 error（resume 只处理一个中断）。
              appendToolResult(id, toolCall.id, JSON.stringify({ error: '已有待确认的工具调用，请先处理' }))
            } else {
              confirmCall = { callId: toolCall.id, toolName: name, args }
            }
            continue
          }

          // 其它工具：建 ctx（副作用白名单）→ 经工厂统一分发 → 拿 ToolResult。
          const ctx = buildToolContext({ sessionId: id, runId, signal: opts.signal, callId: toolCall.id, toolName: name })
          const toolSpan = startSpan('tool.call', {
            kind: 'tool',
            parent: traceSpan,
            attrs: { sessionId: id, runId, turnId, toolName: name, callId: toolCall.id, args },
          })
          let result: ToolResult
          try {
            result = await toolRegistry.run(name, args, ctx)
            const traced = toolResultTrace(result, args)
            endSpan(toolSpan, traced.status, traced.attrs, traced.err)
          } catch (err) {
            endSpan(toolSpan, abortStatus(opts.signal), { error: safeErrorMessage(err) }, err)
            throw err
          } finally {
            // 无论正常返回还是 AbortError 抛出，都清掉该 tool 的进度条目 —— 否则 stop 后 UI 残留卡住的进度行（codex P2）。
            removeToolActivity(id, toolCall.id)
          }

          // TK8「每步不漏」：execute 可能异步且 signal 穿透其中，await 后写回前再查会话还在、且仍是本次 run；
          // 被顶掉的旧 run 不得把迟到 result 写进新 run；esc 中断则收成 stopped。
          if (!isCurrentRun(id, runId)) {
            finishTrace('cancelled', 'agent.stale_run', { reason: 'stale_run' })
            return
          }
          if (opts.signal.aborted) {
            if (isCurrentRun(id, runId)) patchRun(id, { status: 'stopped' })
            finishTrace('cancelled', 'agent.stopped', { reason: 'aborted' })
            return
          }

          // 结果映射（§4）：pause 延后处理；ok → data JSON；error → {error} JSON（TK6，不打断）。
          if ('pause' in result) {
            if (interruptPending()) {
              // 已有中断（ask_user/危险工具）→ 这个多余的 pause 补个 result，别让它 orphan。
              appendToolResult(id, toolCall.id, JSON.stringify({ error: 'already pausing' }))
            } else {
              pauseCall = { callId: toolCall.id, payload: result.pause } // 不 append，留给 resume 回填
            }
          } else {
            appendMappedToolResult(id, toolCall.id, result)
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
          patchRun(id, { status: 'waiting_confirmation', pendingToolConfirmation: confirmCall })
          return
        }

        // 再处理 ask_user 暂停：TK7「已回答」守卫 —— resume 后本轮已回填过 ask_user 的 result
        //   → 不再暂停，回 {error:'user_answers_already_provided'} 让 model 用已给答案续跑，防死循环；
        //   否则暂停 run（waiting_user + pendingQuestion），该 tool 的 result 留给 resume 回填。
        if (pauseCall) {
          if (askAlreadyAnswered(id)) {
            traceEvent('agent.waiting_user_skipped', { callId: pauseCall.callId, reason: 'already_answered' })
            appendToolResult(id, pauseCall.callId, JSON.stringify({ error: 'user_answers_already_provided' }))
          } else {
            traceEvent('agent.waiting_user', {
              callId: pauseCall.callId,
              question_count: questionCount(pauseCall.payload),
            })
            patchRun(id, { status: 'waiting_user', pendingQuestion: pauseCall.payload })
            return
          }
        }

        continue
      }

      // ── 无 tool_calls：最终答案。空回复（null/空串/纯空白）当失败，不写、不 commit。
      const content = msg?.content
      if (!content || !content.trim()) {
        if (isCurrentRun(id, runId)) patchRun(id, { status: 'error', error: '模型返回空回复' })
        finishTrace('error', 'agent.error', { error: '模型返回空回复' })
        return
      }

      if (!streamedAssistantItemId) {
        appendItem(id, {
          id: newId(),
          createdAt: Date.now(),
          item: assistantItemFromMessage(msg, content),
        })
      }
      commitCheckpoint(id, input.slice(0, 20)) // TK9：一轮用户输入收尾 = 一个 checkpoint。
      // D-4 持久化接线：把刚提交的这一轮 checkpoint 落盘 + 会话列表落盘（fire-and-forget，DK2）。
      const checkpoints = getSessionStore(id).store.getter(checkpointsAtom)
      const committed = checkpoints[checkpoints.length - 1]
      if (committed) {
        traceEvent('checkpoint.commit', { turnIndex: committed.turnIndex, items_count: committed.items.length })
        persistCheckpoint(id, committed)
      }
      persistSessions()
      patchRun(id, { status: 'done' })
      finishTrace('ok', 'agent.done', { status: 'done' })
      return
    }

    // 循环跑满 MAX_AGENT_TURNS 仍未收尾 → 降级为 error（TK8 上限保护）。
    if (isCurrentRun(id, runId)) patchRun(id, { status: 'error', error: '超过最大工具轮数' })
    finishTrace('error', 'agent.max_turns', { max_turns: MAX_AGENT_TURNS, error: '超过最大工具轮数' })
  } catch (err) {
    // U7 降级：被 esc 中断 → 'stopped'（仅当仍是本次 run，避免污染新 run）。
    if (err instanceof DOMException && err.name === 'AbortError') {
      if (isCurrentRun(id, runId)) patchRun(id, { status: 'stopped' })
      finishTrace('cancelled', 'agent.stopped', { reason: 'abort_error' }, err)
      return
    }
    // 其它失败 → 'error'（不抛崩 UI；仅当仍是本次 run）。
    if (isCurrentRun(id, runId)) {
      patchRun(id, { status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
    finishTrace('error', 'agent.error', { error: safeErrorMessage(err) }, err)
  }
}
