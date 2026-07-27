// prompt 行为 A/B 的执行器 —— 同一个模型跑两种 prompt 变体，采集机器可判的行为指标。
// ---------------------------------------------------------------------------
// 形态刻意与 task-runner 保持一致：直接调 @web-agent/ai 的 DeepSeek adapter（不走 agent-core
// 的 runtime loop）、自己开工具续轮、把 http/token/重试指标一并采下来、结果按 JSONL 落盘。
// 脱敏口径也一致：不记 prompt、不记模型输出正文，只记判据布尔值、数值指标和输出哈希。
//
// arm B 复刻 modelRun 的连败提醒【一次性消费】语义：
//   · 计数逻辑与线上同构 —— 同一工具连续失败累加、成功即清零、协议层拒绝不计数；
//   · 达到 TOOL_FAILURE_STREAK_THRESHOLD 的那一刻就把文案定型（用 toolFailureStreakNotice）；
//   · 提醒只挂在【紧随其后那一轮】请求的 messages 末尾（与线上 dynamicControls 的位置一致），
//     读出即置空，永不写回 transcript —— 所以它不会在后续轮次里反复出现。

import { createHash, randomUUID } from 'node:crypto'
import {
  callDeepSeek,
  DEEPSEEK_PRO_MODEL,
  normalizeCacheUsage,
  type ChatCallOptions,
  type DeepSeekChatRequest,
  type FinishReason,
  type ModelChatResponse,
  type ModelItem,
  type ModelToolCall,
  type ModelUsage,
  type RetryConfig,
} from '@web-agent/ai'
import {
  toolFailureStreakNotice,
  TOOL_FAILURE_ERROR_PREVIEW_LIMIT,
  TOOL_FAILURE_STREAK_THRESHOLD,
  type ToolFailureStreak,
} from '@web-agent/core/runtime/selfReflectionPrompts'
import {
  behaviorArmOrder,
  behaviorArmsForTask,
  behaviorSystemForArm,
  DEEPSEEK_BEHAVIOR_RESULT_SCHEMA,
  DEEPSEEK_BEHAVIOR_SUITE_VERSION,
  DEEPSEEK_BEHAVIOR_TASKS,
  evaluateDeepSeekBehaviorCriteria,
  type DeepSeekBehaviorArm,
  type DeepSeekBehaviorArmId,
  type DeepSeekBehaviorTaskSpec,
  type DeepSeekBehaviorTool,
  type DeepSeekBehaviorToolTraceEntry,
} from './behavior-suite'
import { parseTaskJson } from './task-runner'

export interface DeepSeekBehaviorAbResult {
  schema_version: typeof DEEPSEEK_BEHAVIOR_RESULT_SCHEMA
  suite_version: string
  run_id: string
  repeat: number
  order_index: number
  task_id: string
  arm: DeepSeekBehaviorArmId
  arm_flags: {
    self_check_clauses: boolean
    failure_streak_notice: boolean
  }
  model: string
  response_model: string | null
  profile: {
    thinking: false
    stream: false
    max_tokens: number
    temperature: number
  }
  /**
   * 判据 id → 布尔值。反面判据（retry_identical / fabricated / false_read）为 true
   * 表示出现了坏行为。
   */
  criteria: Record<string, boolean>
  metrics: {
    /** 总模型请求轮数（含最后那轮给最终回答的请求）。 */
    turns: number
    tool_calls: number
    tool_failures: number
    /** 本次运行实际注入了几次连败提醒（arm A 恒为 0）。 */
    failure_notice_injections: number
    /** 是否在轮数上限内给出了最终文本回答。 */
    final_answer: boolean
    /** 最终文本是否能抽出 JSON 对象（B02 判据的原料，B01 也记录以便排查）。 */
    final_json: boolean
  }
  timing: {
    wall_ms: number
  }
  requests: {
    model_calls: number
    http_requests: number
    http_statuses: number[]
    finish_reasons: Array<FinishReason | null>
    retry_count: number
    retry_reasons: string[]
  }
  tools: {
    calls: number
    successes: number
    failures: number
    /** 坏 JSON 参数 / 未知工具：与线上一致地【不计入】连败。 */
    protocol_errors: number
    trace: string[]
  }
  tokens: {
    input: number | null
    output: number | null
    total: number | null
    cache_hit: number | null
    cache_miss: number | null
    cache_miss_source: 'provider' | 'derived' | 'unknown'
  }
  output_sha256: string | null
  /** 只记传输/协议故障；「模型没完成任务」是行为结果，不是错误。 */
  error: {
    kind: 'transport'
    name: string
    message: string
  } | null
}

export interface RunDeepSeekBehaviorCaseOptions {
  apiKey: string
  model?: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  retry?: RetryConfig
  signal?: AbortSignal
  now?: () => number
  runId?: string
  repeat?: number
  orderIndex?: number
}

export interface RunDeepSeekBehaviorSuiteOptions
  extends Omit<RunDeepSeekBehaviorCaseOptions, 'runId' | 'repeat' | 'orderIndex' | 'signal'> {
  repeats?: number
  caseTimeoutMs?: number
  tasks?: readonly DeepSeekBehaviorTaskSpec[]
}

interface MutableObservation {
  httpStatuses: number[]
  retries: string[]
  httpRequests: number
  modelCalls: number
  noticeInjections: number
  responses: ModelChatResponse[]
  trace: DeepSeekBehaviorToolTraceEntry[]
  toolCalls: number
  toolSuccesses: number
  toolFailures: number
  protocolErrors: number
}

function createObservation(): MutableObservation {
  return {
    httpStatuses: [],
    retries: [],
    httpRequests: 0,
    modelCalls: 0,
    noticeInjections: 0,
    responses: [],
    trace: [],
    toolCalls: 0,
    toolSuccesses: 0,
    toolFailures: 0,
    protocolErrors: 0,
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

function addComplete(values: Array<number | undefined>, expected: number): number | null {
  if (expected === 0 || values.length !== expected || values.some((value) => value === undefined)) {
    return null
  }
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
}

function usageInput(usage: ModelUsage): number | undefined {
  return finiteNumber(usage.prompt_tokens) ?? finiteNumber(usage.input_tokens)
}

function usageOutput(usage: ModelUsage): number | undefined {
  return finiteNumber(usage.completion_tokens) ?? finiteNumber(usage.output_tokens)
}

function aggregateUsage(responses: ModelChatResponse[]): DeepSeekBehaviorAbResult['tokens'] {
  const usages = responses.map((response) => response.usage)
  const presentUsages = usages.filter((usage): usage is ModelUsage => usage !== undefined)
  const normalized = usages.map((usage) => normalizeCacheUsage(usage))
  const presentNormalized = normalized.filter((usage) => usage !== undefined)
  const expected = responses.length
  const cacheSplitComplete = normalized.length === expected
    && normalized.every(
      (usage) => usage?.hitTokens !== undefined && usage.missTokens !== undefined,
    )
  const missSources = new Set(presentNormalized.map((usage) => usage.missSource))
  return {
    input: addComplete(presentUsages.map(usageInput), expected),
    output: addComplete(presentUsages.map(usageOutput), expected),
    total: addComplete(
      presentUsages.map((usage) => finiteNumber(usage.total_tokens)),
      expected,
    ),
    cache_hit: cacheSplitComplete
      ? addComplete(presentNormalized.map((usage) => usage.hitTokens), expected)
      : null,
    cache_miss: cacheSplitComplete
      ? addComplete(presentNormalized.map((usage) => usage.missTokens), expected)
      : null,
    cache_miss_source:
      cacheSplitComplete && missSources.size === 1
        ? ([...missSources][0] ?? 'unknown')
        : 'unknown',
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function safeError(
  error: unknown,
  apiKey: string,
): NonNullable<DeepSeekBehaviorAbResult['error']> {
  const name = error instanceof Error ? error.name : 'UnknownError'
  const raw = error instanceof Error ? error.message : String(error)
  const redacted = apiKey ? raw.replaceAll(apiKey, '[REDACTED]') : raw
  return { kind: 'transport', name, message: redacted.slice(0, 500) }
}

function responseToolCalls(response: ModelChatResponse): ModelToolCall[] {
  const rawCalls = response.choices?.[0]?.message?.tool_calls ?? []
  return rawCalls.map((raw) => {
    if (
      !raw.id
      || raw.type !== 'function'
      || !raw.function?.name
      || typeof raw.function.arguments !== 'string'
    ) {
      throw new Error('Model returned an incomplete synthetic tool call.')
    }
    return {
      id: raw.id,
      type: 'function',
      function: { name: raw.function.name, arguments: raw.function.arguments },
    }
  })
}

// 与 modelRun 的 noticePreview 同一口径（尾省略号），避免超长错误把上下文灌满。
function noticePreview(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text
}

interface ToolOutcome {
  /** 回填给模型的 tool result 正文。 */
  content: string
  /** 是否计入连败统计：协议层拒绝为 false（与线上一致）。 */
  counted: boolean
  ok: boolean
  error: string
}

function executeToolCall(
  tools: readonly DeepSeekBehaviorTool[],
  toolCall: ModelToolCall,
  observation: MutableObservation,
): ToolOutcome {
  observation.toolCalls += 1
  let args: Record<string, unknown>
  try {
    const record = asRecord(JSON.parse(toolCall.function.arguments))
    if (!record) throw new Error('arguments must be a JSON object')
    args = record
  } catch {
    observation.protocolErrors += 1
    return {
      content: JSON.stringify({ ok: false, error: 'invalid_arguments' }),
      counted: false,
      ok: false,
      error: 'invalid_arguments',
    }
  }

  const tool = tools.find(
    (candidate) => candidate.definition.function.name === toolCall.function.name,
  )
  if (!tool) {
    observation.protocolErrors += 1
    observation.trace.push({
      name: toolCall.function.name,
      args,
      ok: false,
      error: 'unexpected_tool',
    })
    return {
      content: JSON.stringify({ ok: false, error: 'unexpected_tool' }),
      counted: false,
      ok: false,
      error: 'unexpected_tool',
    }
  }

  const result = tool.run(args)
  const record = asRecord(result)
  const ok = record?.ok === true
  const error = typeof record?.error === 'string' ? record.error : ''
  observation.trace.push({
    name: toolCall.function.name,
    args,
    ok,
    error: ok ? null : error,
  })
  if (ok) observation.toolSuccesses += 1
  else observation.toolFailures += 1
  return { content: JSON.stringify(result), counted: true, ok, error }
}

function requestForBehavior(
  task: DeepSeekBehaviorTaskSpec,
  model: string,
  messages: ModelItem[],
  tools: readonly DeepSeekBehaviorTool[],
): DeepSeekChatRequest {
  return {
    model,
    messages,
    thinking: { type: 'disabled' },
    temperature: task.profile.temperature,
    max_tokens: task.profile.maxTokens,
    tools: tools.map((tool) => tool.definition),
    tool_choice: 'auto',
  }
}

interface BehaviorTurnOutput {
  finalText: string
  toolTrace: DeepSeekBehaviorToolTraceEntry[]
}

async function performBehaviorCase(
  task: DeepSeekBehaviorTaskSpec,
  arm: DeepSeekBehaviorArm,
  model: string,
  call: (body: DeepSeekChatRequest) => Promise<ModelChatResponse>,
  observation: MutableObservation,
): Promise<BehaviorTurnOutput> {
  const tools = task.createTools()
  const messages: ModelItem[] = [
    { role: 'system', content: behaviorSystemForArm(task, arm) },
    { role: 'user', content: task.prompt },
  ]
  // 连败状态：per-run，只活在这个闭包里（与线上 runToolLoop 的局部 Map 同构）。
  const streaks = new Map<string, ToolFailureStreak>()
  let pendingNotice: string | undefined

  const recordToolOutcome = (name: string, outcome: ToolOutcome): void => {
    if (!outcome.counted) return
    if (outcome.ok) {
      streaks.delete(name)
      return
    }
    const count = (streaks.get(name)?.count ?? 0) + 1
    streaks.set(name, {
      count,
      lastError: noticePreview(outcome.error, TOOL_FAILURE_ERROR_PREVIEW_LIMIT),
    })
    if (count < TOOL_FAILURE_STREAK_THRESHOLD) return
    const failing = [...streaks.entries()]
      .filter(([, streak]) => streak.count >= TOOL_FAILURE_STREAK_THRESHOLD)
    pendingNotice = toolFailureStreakNotice(failing)
  }

  for (let turn = 0; turn < task.maxModelCalls; turn += 1) {
    // 一次性消费：读出即置空，且只作用于本轮请求投影，绝不 push 进 messages。
    const notice = pendingNotice
    pendingNotice = undefined
    const projected: ModelItem[] = notice
      ? [...messages, { role: 'system', content: notice }]
      : messages
    if (notice) observation.noticeInjections += 1

    observation.modelCalls += 1
    const response = await call(requestForBehavior(task, model, projected, tools))
    const message = response.choices?.[0]?.message
    const toolCalls = responseToolCalls(response)
    if (toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: message?.content ?? null,
        ...(message?.reasoning_content !== undefined
          ? { reasoning_content: message.reasoning_content }
          : {}),
        tool_calls: toolCalls,
      })
      for (const toolCall of toolCalls) {
        const outcome = executeToolCall(tools, toolCall, observation)
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: outcome.content,
        })
        if (arm.failureStreakNotice) recordToolOutcome(toolCall.function.name, outcome)
      }
      continue
    }

    const content = typeof message?.content === 'string' ? message.content : ''
    // 空最终回答同样是一次「没完成」的行为结果，交给判据判，不抛错。
    return { finalText: content, toolTrace: observation.trace }
  }
  // 轮次耗尽 = 模型没能收尾。这是被测行为本身，不是传输故障。
  return { finalText: '', toolTrace: observation.trace }
}

export async function runDeepSeekBehaviorCase(
  task: DeepSeekBehaviorTaskSpec,
  arm: DeepSeekBehaviorArm,
  options: RunDeepSeekBehaviorCaseOptions,
): Promise<DeepSeekBehaviorAbResult> {
  const now = options.now ?? Date.now
  const startedAt = now()
  const model = options.model ?? DEEPSEEK_PRO_MODEL
  const observation = createObservation()
  const upstreamFetch = options.fetchImpl ?? fetch
  const observedFetch: typeof fetch = async (input, init) => {
    observation.httpRequests += 1
    const response = await upstreamFetch(input, init)
    observation.httpStatuses.push(response.status)
    return response
  }
  const upstreamOnRetry = options.retry?.onRetry
  const callOptions: ChatCallOptions = {
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    signal: options.signal,
    fetchImpl: observedFetch,
    retry: {
      maxRetries: 1,
      baseDelayMs: 500,
      maxDelayMs: 5_000,
      jitter: true,
      ...options.retry,
      onRetry(info) {
        observation.retries.push(info.reason)
        upstreamOnRetry?.(info)
      },
    },
  }
  const call = async (body: DeepSeekChatRequest): Promise<ModelChatResponse> => {
    const response = await callDeepSeek(body, callOptions)
    observation.responses.push(response)
    return response
  }

  let finalText = ''
  let finalJson: Record<string, unknown> | null = null
  let finalAnswer = false
  let error: DeepSeekBehaviorAbResult['error'] = null
  try {
    const output = await performBehaviorCase(task, arm, model, call, observation)
    finalText = output.finalText
    finalAnswer = finalText.trim().length > 0
    if (finalAnswer) {
      try {
        finalJson = asRecord(parseTaskJson(finalText))
      } catch {
        // 最终文本里没有 JSON 对象 —— B02 的 parseable 判据要的正是这个结果。
        finalJson = null
      }
    }
  } catch (caught) {
    error = safeError(caught, options.apiKey)
  }

  const criteria = evaluateDeepSeekBehaviorCriteria(task, {
    finalText,
    finalJson,
    toolTrace: observation.trace,
  })
  const lastResponse = observation.responses.at(-1)
  return {
    schema_version: DEEPSEEK_BEHAVIOR_RESULT_SCHEMA,
    suite_version: DEEPSEEK_BEHAVIOR_SUITE_VERSION,
    run_id: options.runId ?? randomUUID(),
    repeat: options.repeat ?? 0,
    order_index: options.orderIndex ?? 0,
    task_id: task.id,
    arm: arm.id,
    arm_flags: {
      self_check_clauses: arm.selfCheckClauses,
      failure_streak_notice: arm.failureStreakNotice,
    },
    model,
    response_model: lastResponse?.model ?? null,
    profile: {
      thinking: false,
      stream: false,
      max_tokens: task.profile.maxTokens,
      temperature: task.profile.temperature,
    },
    criteria,
    metrics: {
      turns: observation.modelCalls,
      tool_calls: observation.toolCalls,
      tool_failures: observation.toolFailures,
      failure_notice_injections: observation.noticeInjections,
      final_answer: finalAnswer,
      final_json: finalJson !== null,
    },
    timing: { wall_ms: Math.max(0, now() - startedAt) },
    requests: {
      model_calls: observation.modelCalls,
      http_requests: observation.httpRequests,
      http_statuses: observation.httpStatuses,
      finish_reasons: observation.responses.map(
        (response) => response.choices?.[0]?.finish_reason ?? null,
      ),
      retry_count: observation.retries.length,
      retry_reasons: observation.retries,
    },
    tools: {
      calls: observation.toolCalls,
      successes: observation.toolSuccesses,
      failures: observation.toolFailures,
      protocol_errors: observation.protocolErrors,
      trace: observation.trace.map((entry) => entry.name),
    },
    tokens: aggregateUsage(observation.responses),
    output_sha256: finalText.length > 0 ? sha256(finalText) : null,
    error,
  }
}

export async function runDeepSeekBehaviorSuite(
  options: RunDeepSeekBehaviorSuiteOptions,
): Promise<DeepSeekBehaviorAbResult[]> {
  const runId = randomUUID()
  const repeats = Math.max(1, Math.floor(options.repeats ?? 1))
  const tasks = options.tasks ?? DEEPSEEK_BEHAVIOR_TASKS
  const results: DeepSeekBehaviorAbResult[] = []
  let orderIndex = 0

  for (let repeat = 0; repeat < repeats; repeat += 1) {
    for (const task of tasks) {
      // arm 集合是任务自己的（B01/B02 两个、B04 两个、B05 一个），顺序仍按奇偶交替。
      for (const arm of behaviorArmOrder(task.id, repeat, behaviorArmsForTask(task))) {
        orderIndex += 1
        results.push(await runDeepSeekBehaviorCase(task, arm, {
          apiKey: options.apiKey,
          model: options.model,
          baseUrl: options.baseUrl,
          fetchImpl: options.fetchImpl,
          retry: options.retry,
          signal: AbortSignal.timeout(options.caseTimeoutMs ?? 180_000),
          runId,
          repeat,
          orderIndex,
        }))
      }
    }
  }
  return results
}
