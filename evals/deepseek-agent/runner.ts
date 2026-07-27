import {
  callDeepSeek,
  normalizeCacheUsage,
  streamDeepSeek,
  type ChatCallOptions,
  type DeepSeekChatRequest,
  type FinishReason,
  type ModelChatResponse,
  type ModelFunctionTool,
  type ModelItem,
  type ModelToolCall,
  type ModelUsage,
  type RetryConfig,
} from '@web-agent/ai'
import type { DeepSeekEvalCase } from './matrix'

const ADD_TOOL: ModelFunctionTool = {
  type: 'function',
  function: {
    name: 'add',
    description: 'Add two integers and return their sum.',
    parameters: {
      type: 'object',
      properties: {
        left: { type: 'integer' },
        right: { type: 'integer' },
      },
      required: ['left', 'right'],
      additionalProperties: false,
    },
  },
}

export interface DeepSeekEvalResult {
  case_id: string
  success: boolean
  model: string
  response_model: string | null
  thinking: boolean
  effort: string | null
  stream: boolean
  tool_call: boolean
  started_at: string
  latency_ms: number
  request_count: number
  request_shapes: DeepSeekRequestShape[]
  stream_delta_count: number
  http_status: number | null
  http_statuses: number[]
  finish_reason: FinishReason | null
  finish_reasons: Array<FinishReason | null>
  retry_count: number
  retry_reasons: string[]
  tokens: {
    input: number | null
    output: number | null
    total: number | null
  }
  cache: {
    hit: number | null
    miss: number | null
    miss_source: 'provider' | 'derived' | 'unknown'
  }
  error?: {
    name: string
    message: string
  }
}

export interface DeepSeekRequestShape {
  body_parseable: boolean
  has_tool_choice: boolean | null
  has_thinking: boolean | null
  has_tools: boolean | null
  assistant_tool_call: {
    has_reasoning_content: boolean
    content_non_null: boolean
  } | null
}

export interface RunDeepSeekEvalCaseOptions {
  apiKey: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  retry?: RetryConfig
  signal?: AbortSignal
  now?: () => number
}

interface MutableObservation {
  httpStatuses: number[]
  retries: string[]
  requestCount: number
  requestShapes: DeepSeekRequestShape[]
  streamDeltaCount: number
  responses: ModelChatResponse[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function requestShape(init?: RequestInit): DeepSeekRequestShape {
  if (typeof init?.body !== 'string') {
    return {
      body_parseable: false,
      has_tool_choice: null,
      has_thinking: null,
      has_tools: null,
      assistant_tool_call: null,
    }
  }

  let body: unknown
  try {
    body = JSON.parse(init.body)
  } catch {
    return {
      body_parseable: false,
      has_tool_choice: null,
      has_thinking: null,
      has_tools: null,
      assistant_tool_call: null,
    }
  }
  if (!isRecord(body)) {
    return {
      body_parseable: false,
      has_tool_choice: null,
      has_thinking: null,
      has_tools: null,
      assistant_tool_call: null,
    }
  }

  const assistantToolCall = Array.isArray(body.messages)
    ? body.messages.find((message) =>
      isRecord(message) &&
      message.role === 'assistant' &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0
    )
    : undefined

  return {
    body_parseable: true,
    has_tool_choice: hasOwn(body, 'tool_choice'),
    has_thinking: hasOwn(body, 'thinking'),
    has_tools: hasOwn(body, 'tools'),
    assistant_tool_call: assistantToolCall
      ? {
        has_reasoning_content: hasOwn(assistantToolCall, 'reasoning_content'),
        content_non_null:
          hasOwn(assistantToolCall, 'content') &&
          assistantToolCall.content !== null,
      }
      : null,
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function addOptional(values: Array<number | undefined>): number | null {
  const present = values.filter((value): value is number => value !== undefined)
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : null
}

function usageInput(usage: ModelUsage): number | undefined {
  return finiteNumber(usage.prompt_tokens) ?? finiteNumber(usage.input_tokens)
}

function usageOutput(usage: ModelUsage): number | undefined {
  return finiteNumber(usage.completion_tokens) ?? finiteNumber(usage.output_tokens)
}

function aggregateUsage(responses: ModelChatResponse[]): Pick<
  DeepSeekEvalResult,
  'tokens' | 'cache'
> {
  const usages = responses
    .map((response) => response.usage)
    .filter((usage): usage is ModelUsage => usage !== undefined)
  const normalized = usages
    .map((usage) => normalizeCacheUsage(usage))
    .filter((usage) => usage !== undefined)
  const missSources = new Set(normalized.map((usage) => usage.missSource))

  return {
    tokens: {
      input: addOptional(usages.map(usageInput)),
      output: addOptional(usages.map(usageOutput)),
      total: addOptional(usages.map((usage) => finiteNumber(usage.total_tokens))),
    },
    cache: {
      hit: addOptional(normalized.map((usage) => usage.hitTokens)),
      miss: addOptional(normalized.map((usage) => usage.missTokens)),
      miss_source:
        missSources.size === 1
          ? ([...missSources][0] ?? 'unknown')
          : 'unknown',
    },
  }
}

function finishReasons(responses: ModelChatResponse[]): Array<FinishReason | null> {
  return responses.map((response) => response.choices?.[0]?.finish_reason ?? null)
}

function requiredToolCall(response: ModelChatResponse): ModelToolCall {
  const raw = response.choices?.[0]?.message?.tool_calls?.[0]
  if (
    !raw?.id ||
    raw.type !== 'function' ||
    !raw.function?.name ||
    typeof raw.function.arguments !== 'string'
  ) {
    throw new Error('DeepSeek did not return a complete function tool call.')
  }
  return {
    id: raw.id,
    type: 'function',
    function: {
      name: raw.function.name,
      arguments: raw.function.arguments,
    },
  }
}

function evaluateToolCall(toolCall: ModelToolCall): string {
  if (toolCall.function.name !== 'add') {
    throw new Error(`DeepSeek called unexpected tool "${toolCall.function.name}".`)
  }
  const args = JSON.parse(toolCall.function.arguments) as {
    left?: unknown
    right?: unknown
  }
  if (!Number.isInteger(args.left) || !Number.isInteger(args.right)) {
    throw new Error('DeepSeek add arguments were not integers.')
  }
  return JSON.stringify({
    result: Number(args.left) + Number(args.right),
  })
}

function requestBody(testCase: DeepSeekEvalCase, messages: ModelItem[]): DeepSeekChatRequest {
  return {
    model: testCase.model,
    messages,
    thinking: { type: testCase.thinking ? 'enabled' : 'disabled' },
    ...(testCase.effort ? { reasoning_effort: testCase.effort } : {}),
    max_tokens: 256,
  }
}

function errorInfo(error: unknown, apiKey: string): NonNullable<DeepSeekEvalResult['error']> {
  const name = error instanceof Error ? error.name : 'UnknownError'
  const raw = error instanceof Error ? error.message : String(error)
  return {
    name,
    message: apiKey ? raw.replaceAll(apiKey, '[REDACTED]') : raw,
  }
}

export async function runDeepSeekEvalCase(
  testCase: DeepSeekEvalCase,
  options: RunDeepSeekEvalCaseOptions,
): Promise<DeepSeekEvalResult> {
  const now = options.now ?? Date.now
  const startedAtMs = now()
  const observation: MutableObservation = {
    httpStatuses: [],
    retries: [],
    requestCount: 0,
    requestShapes: [],
    streamDeltaCount: 0,
    responses: [],
  }
  const upstreamFetch = options.fetchImpl ?? fetch
  const observedFetch: typeof fetch = async (input, init) => {
    observation.requestCount += 1
    observation.requestShapes.push(requestShape(init))
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
    const response = testCase.stream
      ? await streamDeepSeek(body, callOptions, {
        onDelta: () => {
          observation.streamDeltaCount += 1
        },
      })
      : await callDeepSeek(body, callOptions)
    observation.responses.push(response)
    return response
  }

  let error: DeepSeekEvalResult['error']
  try {
    const messages: ModelItem[] = [
      {
        role: 'system',
        content: 'Follow the request exactly. Keep the final answer under 20 words.',
      },
      {
        role: 'user',
        content: testCase.toolCall
          ? 'Use the add tool to calculate 2 + 3, then state the result.'
          : 'Reply with exactly: pong',
      },
    ]
    const firstBody = requestBody(testCase, messages)
    if (!testCase.toolCall) {
      const response = await call(firstBody)
      const content = response.choices?.[0]?.message?.content
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new Error('DeepSeek returned no final text.')
      }
    } else {
      const first = await call({
        ...firstBody,
        tools: [ADD_TOOL],
        tool_choice: { type: 'function', function: { name: 'add' } },
      })
      const toolCall = requiredToolCall(first)
      const assistant = first.choices?.[0]?.message
      const toolResult = evaluateToolCall(toolCall)
      const second = await call({
        ...requestBody(testCase, [
          ...messages,
          {
            role: 'assistant',
            content: assistant?.content ?? null,
            ...(assistant?.reasoning_content !== undefined
              ? { reasoning_content: assistant.reasoning_content }
              : {}),
            tool_calls: [toolCall],
          },
          {
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolResult,
          },
        ]),
        tools: [ADD_TOOL],
        tool_choice: 'auto',
      })
      const content = second.choices?.[0]?.message?.content
      if (typeof content !== 'string' || !content.includes('5')) {
        throw new Error('DeepSeek did not produce the expected final tool result.')
      }
    }
  } catch (caught) {
    error = errorInfo(caught, options.apiKey)
  }

  const reasons = finishReasons(observation.responses)
  const lastResponse = observation.responses.at(-1)
  const lastStatus = observation.httpStatuses.at(-1)
  return {
    case_id: testCase.id,
    success: error === undefined,
    model: testCase.model,
    response_model: lastResponse?.model ?? null,
    thinking: testCase.thinking,
    effort: testCase.effort,
    stream: testCase.stream,
    tool_call: testCase.toolCall,
    started_at: new Date(startedAtMs).toISOString(),
    latency_ms: Math.max(0, now() - startedAtMs),
    request_count: observation.requestCount,
    request_shapes: observation.requestShapes,
    stream_delta_count: observation.streamDeltaCount,
    http_status: lastStatus ?? null,
    http_statuses: observation.httpStatuses,
    finish_reason: reasons.at(-1) ?? null,
    finish_reasons: reasons,
    retry_count: observation.retries.length,
    retry_reasons: observation.retries,
    ...aggregateUsage(observation.responses),
    ...(error ? { error } : {}),
  }
}

export async function runDeepSeekProtocolMatrix(
  testCases: DeepSeekEvalCase[],
  options: RunDeepSeekEvalCaseOptions,
): Promise<DeepSeekEvalResult[]> {
  const results: DeepSeekEvalResult[] = []
  // Live smoke 有意串行，避免测试自身制造限流，也让单条记录的 latency 可解释。
  for (const testCase of testCases) {
    results.push(await runDeepSeekEvalCase(testCase, options))
  }
  return results
}
