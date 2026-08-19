import { createHash, randomUUID } from 'node:crypto'
import {
  callDeepSeek,
  normalizeCacheUsage,
  type ChatCallOptions,
  type DeepSeekChatRequest,
  type FinishReason,
  type ModelChatResponse,
  type ModelItem,
  type ModelToolCall,
  type ModelUsage,
  type RetryConfig,
} from '@einfach-agent/ai'
import {
  DEEPSEEK_TASK_RESULT_SCHEMA,
  DEEPSEEK_TASK_SUITE_VERSION,
  DEEPSEEK_TASKS,
  scoreDeepSeekTask,
  shadowRouteForTask,
  taskLaneOrder,
  type DeepSeekTaskArm,
  type DeepSeekTaskLane,
  type DeepSeekTaskScore,
  type DeepSeekTaskSpec,
  type DeepSeekTaskToolTraceEntry,
} from './task-suite'

export interface DeepSeekTaskAbResult {
  schema_version: typeof DEEPSEEK_TASK_RESULT_SCHEMA
  suite_version: string
  run_id: string
  replicate: number
  order_index: number
  task_id: string
  category: string
  fixture_sha256: string
  prompt_version: string
  scorer_version: string
  route_features: {
    task_category: string | null
    risk_level: string | null
    cross_module: boolean
    final_acceptance: boolean
    requires_temporal_normalization: boolean
  }
  shadow_route: {
    tier: string
    reason: string
  }
  arm: DeepSeekTaskArm
  model: string
  response_model: string | null
  profile: {
    thinking: boolean
    reasoning_effort: string | null
    stream: false
    max_tokens: number
  }
  score: DeepSeekTaskScore
  timing: {
    wall_ms: number
    ttft_ms: null
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
    schema_errors: number
    unexpected: number
    duplicate_exact_calls: number
    recovery_turns: number
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
  fallback_count: 0
  output_sha256: string | null
  error: {
    kind: 'transport' | 'task_output'
    name: string
    message: string
  } | null
}

export interface RunDeepSeekTaskCaseOptions {
  apiKey: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  retry?: RetryConfig
  signal?: AbortSignal
  now?: () => number
  runId?: string
  replicate?: number
  orderIndex?: number
}

export interface RunDeepSeekTaskSuiteOptions
  extends Omit<RunDeepSeekTaskCaseOptions, 'runId' | 'replicate' | 'orderIndex' | 'signal'> {
  repeats?: number
  caseTimeoutMs?: number
  tasks?: readonly DeepSeekTaskSpec[]
}

interface MutableToolObservation {
  trace: DeepSeekTaskToolTraceEntry[]
  calls: number
  successes: number
  schemaErrors: number
  unexpected: number
  duplicateExactCalls: number
  recoveryTurns: number
  seenCalls: Set<string>
}

interface MutableObservation {
  httpStatuses: number[]
  retries: string[]
  httpRequests: number
  modelCalls: number
  responses: ModelChatResponse[]
  tools: MutableToolObservation
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

function aggregateUsage(responses: ModelChatResponse[]): DeepSeekTaskAbResult['tokens'] {
  const usages = responses.map((response) => response.usage)
  const presentUsages = usages.filter((usage): usage is ModelUsage => usage !== undefined)
  const normalized = usages.map((usage) => normalizeCacheUsage(usage))
  const presentNormalized = normalized.filter((usage) => usage !== undefined)
  const completeUsageCount = responses.length
  const cacheSplitComplete = normalized.length === completeUsageCount
    && normalized.every(
      (usage) => usage?.hitTokens !== undefined && usage.missTokens !== undefined,
    )
  const missSources = new Set(presentNormalized.map((usage) => usage.missSource))
  return {
    input: addComplete(presentUsages.map(usageInput), completeUsageCount),
    output: addComplete(presentUsages.map(usageOutput), completeUsageCount),
    total: addComplete(
      presentUsages.map((usage) => finiteNumber(usage.total_tokens)),
      completeUsageCount,
    ),
    cache_hit: cacheSplitComplete
      ? addComplete(
          presentNormalized.map((usage) => usage.hitTokens),
          completeUsageCount,
        )
      : null,
    cache_miss: cacheSplitComplete
      ? addComplete(
          presentNormalized.map((usage) => usage.missTokens),
          completeUsageCount,
        )
      : null,
    cache_miss_source:
      cacheSplitComplete && missSources.size === 1
        ? ([...missSources][0] ?? 'unknown')
        : 'unknown',
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function sha256(value: unknown): string {
  return createHash('sha256').update(
    typeof value === 'string' ? value : stableJson(value),
  ).digest('hex')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

class TaskOutputError extends Error {
  override name = 'TaskOutputError'
}

export function parseTaskJson(text: string): unknown {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // Models sometimes wrap an otherwise valid object in a short preamble or a JSON fence.
    // Scan a balanced object without persisting or echoing the surrounding text.
  }

  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index]
    if (start < 0) {
      if (character !== '{') continue
      start = index
      depth = 1
      continue
    }
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\' && inString) {
      escaped = true
      continue
    }
    if (character === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (character === '{') depth += 1
    if (character === '}') depth -= 1
    if (depth === 0) {
      try {
        return JSON.parse(trimmed.slice(start, index + 1))
      } catch {
        throw new TaskOutputError('Model output did not contain a valid JSON object.')
      }
    }
  }
  throw new TaskOutputError('Model output did not contain a valid JSON object.')
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
      function: {
        name: raw.function.name,
        arguments: raw.function.arguments,
      },
    }
  })
}

function safeError(error: unknown, apiKey: string): NonNullable<DeepSeekTaskAbResult['error']> {
  const name = error instanceof Error ? error.name : 'UnknownError'
  const raw = error instanceof Error ? error.message : String(error)
  const redacted = apiKey ? raw.replaceAll(apiKey, '[REDACTED]') : raw
  return {
    kind: error instanceof TaskOutputError ? 'task_output' : 'transport',
    name,
    message: redacted.slice(0, 500),
  }
}

function createObservation(): MutableObservation {
  return {
    httpStatuses: [],
    retries: [],
    httpRequests: 0,
    modelCalls: 0,
    responses: [],
    tools: {
      trace: [],
      calls: 0,
      successes: 0,
      schemaErrors: 0,
      unexpected: 0,
      duplicateExactCalls: 0,
      recoveryTurns: 0,
      seenCalls: new Set(),
    },
  }
}

function toolResultHasError(result: unknown): boolean {
  const record = asRecord(result)
  return record !== null && typeof record.error === 'string'
}

function executeToolCall(
  task: DeepSeekTaskSpec,
  toolCall: ModelToolCall,
  observation: MutableToolObservation,
): string {
  observation.calls += 1
  let args: Record<string, unknown>
  try {
    const parsed = JSON.parse(toolCall.function.arguments)
    const record = asRecord(parsed)
    if (!record) throw new Error('arguments must be a JSON object')
    args = record
  } catch {
    observation.schemaErrors += 1
    return JSON.stringify({ error: 'invalid_arguments' })
  }

  observation.trace.push({ name: toolCall.function.name, args })
  const callKey = `${toolCall.function.name}:${stableJson(args)}`
  if (observation.seenCalls.has(callKey)) {
    observation.duplicateExactCalls += 1
    return JSON.stringify({ error: 'duplicate_exact_call' })
  }
  observation.seenCalls.add(callKey)

  const tool = task.tools?.find(
    (candidate) => candidate.definition.function.name === toolCall.function.name,
  )
  if (!tool) {
    observation.unexpected += 1
    return JSON.stringify({ error: 'unexpected_tool' })
  }

  try {
    const result = tool.run(args)
    if (toolResultHasError(result)) observation.recoveryTurns += 1
    else observation.successes += 1
    return JSON.stringify(result)
  } catch {
    observation.schemaErrors += 1
    return JSON.stringify({ error: 'invalid_arguments' })
  }
}

function requestForTask(
  task: DeepSeekTaskSpec,
  lane: DeepSeekTaskLane,
  messages: ModelItem[],
): DeepSeekChatRequest {
  return {
    model: lane.model,
    messages,
    thinking: { type: task.profile.thinking ? 'enabled' : 'disabled' },
    ...(task.profile.reasoningEffort
      ? { reasoning_effort: task.profile.reasoningEffort }
      : {}),
    ...(!task.profile.thinking ? { temperature: 0 } : {}),
    max_tokens: task.profile.maxTokens,
    ...(task.tools
      ? {
          tools: task.tools.map((tool) => tool.definition),
          tool_choice: 'auto' as const,
        }
      : {}),
  }
}

async function performTask(
  task: DeepSeekTaskSpec,
  lane: DeepSeekTaskLane,
  call: (body: DeepSeekChatRequest) => Promise<ModelChatResponse>,
  observation: MutableObservation,
): Promise<string> {
  const messages: ModelItem[] = [
    { role: 'system', content: task.system },
    { role: 'user', content: task.prompt },
  ]
  const maxModelCalls = task.tools ? 4 : 1

  for (let turn = 0; turn < maxModelCalls; turn += 1) {
    observation.modelCalls += 1
    const response = await call(requestForTask(task, lane, messages))
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
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: executeToolCall(task, toolCall, observation.tools),
        })
      }
      continue
    }

    if (typeof message?.content !== 'string' || message.content.trim().length === 0) {
      throw new TaskOutputError('Model returned no final task answer.')
    }
    return message.content
  }
  throw new TaskOutputError('Synthetic tool loop exhausted before a final answer.')
}

function addRunnerHardFailures(
  score: DeepSeekTaskScore,
  observation: MutableObservation,
): DeepSeekTaskScore {
  const failures = [...score.hardFailures]
  if (observation.tools.schemaErrors > 0) failures.push('tool_schema_error')
  if (observation.tools.unexpected > 0) failures.push('unexpected_tool')
  if (observation.tools.duplicateExactCalls > 0) failures.push('duplicate_exact_tool_call')
  return {
    ...score,
    pass: score.pass && failures.length === 0,
    hardFailures: [...new Set(failures)],
  }
}

export async function runDeepSeekTaskCase(
  task: DeepSeekTaskSpec,
  lane: DeepSeekTaskLane,
  options: RunDeepSeekTaskCaseOptions,
): Promise<DeepSeekTaskAbResult> {
  const now = options.now ?? Date.now
  const startedAt = now()
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

  let outputText: string | null = null
  let parsedOutput: unknown = null
  let error: DeepSeekTaskAbResult['error'] = null
  try {
    outputText = await performTask(task, lane, call, observation)
    parsedOutput = parseTaskJson(outputText)
  } catch (caught) {
    error = safeError(caught, options.apiKey)
  }

  let score = scoreDeepSeekTask(task, parsedOutput, observation.tools.trace)
  score = addRunnerHardFailures(score, observation)
  const shadowRoute = shadowRouteForTask(task)
  const lastResponse = observation.responses.at(-1)
  return {
    schema_version: DEEPSEEK_TASK_RESULT_SCHEMA,
    suite_version: DEEPSEEK_TASK_SUITE_VERSION,
    run_id: options.runId ?? randomUUID(),
    replicate: options.replicate ?? 0,
    order_index: options.orderIndex ?? 0,
    task_id: task.id,
    category: task.category,
    fixture_sha256: sha256(task.fixture),
    prompt_version: task.promptVersion,
    scorer_version: task.scorerVersion,
    route_features: {
      task_category: task.routeFeatures.taskCategory ?? null,
      risk_level: task.routeFeatures.riskLevel ?? null,
      cross_module: task.routeFeatures.crossModule ?? false,
      final_acceptance: task.routeFeatures.finalAcceptance ?? false,
      requires_temporal_normalization:
        task.routeFeatures.requiresTemporalNormalization ?? false,
    },
    shadow_route: shadowRoute,
    arm: lane.arm,
    model: lane.model,
    response_model: lastResponse?.model ?? null,
    profile: {
      thinking: task.profile.thinking,
      reasoning_effort: task.profile.reasoningEffort,
      stream: false,
      max_tokens: task.profile.maxTokens,
    },
    score,
    timing: {
      wall_ms: Math.max(0, now() - startedAt),
      ttft_ms: null,
    },
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
      calls: observation.tools.calls,
      successes: observation.tools.successes,
      schema_errors: observation.tools.schemaErrors,
      unexpected: observation.tools.unexpected,
      duplicate_exact_calls: observation.tools.duplicateExactCalls,
      recovery_turns: observation.tools.recoveryTurns,
      trace: observation.tools.trace.map((entry) => entry.name),
    },
    tokens: aggregateUsage(observation.responses),
    fallback_count: 0,
    output_sha256: outputText === null ? null : sha256(outputText),
    error,
  }
}

export async function runDeepSeekTaskSuite(
  options: RunDeepSeekTaskSuiteOptions,
): Promise<DeepSeekTaskAbResult[]> {
  const runId = randomUUID()
  const repeats = Math.max(1, Math.floor(options.repeats ?? 1))
  const tasks = options.tasks ?? DEEPSEEK_TASKS
  const results: DeepSeekTaskAbResult[] = []
  let orderIndex = 0

  for (let replicate = 0; replicate < repeats; replicate += 1) {
    for (const task of tasks) {
      for (const lane of taskLaneOrder(task.id, replicate)) {
        orderIndex += 1
        results.push(await runDeepSeekTaskCase(task, lane, {
          apiKey: options.apiKey,
          baseUrl: options.baseUrl,
          fetchImpl: options.fetchImpl,
          retry: options.retry,
          signal: AbortSignal.timeout(options.caseTimeoutMs ?? 180_000),
          runId,
          replicate,
          orderIndex,
        }))
      }
    }
  }
  return results
}
