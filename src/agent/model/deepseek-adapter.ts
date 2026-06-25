import type {
  AgentTurnContinuation,
  AgentTurnInput,
  AgentTurnResult,
  AgentTurnToolPayload,
  AgentTurnToolRequest,
  GenerateFinalAnswerInput,
  ModelAdapter,
  ModelAnswer,
  ModelConfig,
  ModelStreamEvent,
  SummarizeInput,
  SummarizeResult,
} from './types'
import type { AgentArtifact, AskUserQuestionPayload } from '../runtime/types'

type FetchLike = typeof fetch

type DeepSeekChatResponse = {
  choices?: Array<{
    finish_reason?: string
    message?: {
      role?: 'assistant'
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        id?: string
        type?: 'function'
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
  }>
}

type DeepSeekStreamChunk = {
  choices?: Array<{
    finish_reason?: string | null
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: 'function'
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
  }>
}

type DeepSeekAssistantMessage = NonNullable<NonNullable<DeepSeekChatResponse['choices']>[number]['message']>

type DeepSeekToolCall = NonNullable<DeepSeekAssistantMessage['tool_calls']>[number]

type DeepSeekMessage =
  | {
      role: 'system' | 'user'
      content: string
    }
  | {
      role: 'assistant'
      content: string | null
      reasoning_content?: string | null
      tool_calls?: DeepSeekToolCall[]
    }
  | {
      role: 'tool'
      tool_call_id: string
      content: string
    }

type DeepSeekContinuationState = {
  messages: DeepSeekMessage[]
  pendingToolCalls?: Array<{
    id: string
    name: string
    toolName: string
  }>
  pendingToolCallId?: string
  pendingToolName?: string
}

export class DeepSeekModelAdapter implements ModelAdapter {
  readonly kind = 'deepseek'

  constructor(
    private readonly config: ModelConfig,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  async runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    if (!this.config.apiKey) {
      return {
        type: 'assistant_message',
        source: 'fallback',
        content: input.deterministicAnswer,
        error: 'Missing VITE_DEEPSEEK_API_KEY.',
      }
    }

    try {
      const messages = buildAgentTurnMessages(input)
      const response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          tools: buildAgentTurnTools(input),
          tool_choice: 'auto',
          thinking: {
            type: 'enabled',
          },
          reasoning_effort: 'high',
          temperature: 0,
          stream: true,
        }),
        signal: input.signal,
      })

      if (!response.ok) {
        return {
          type: 'assistant_message',
          source: 'fallback',
          content: input.deterministicAnswer,
          error: `DeepSeek agent turn returned ${response.status}.`,
        }
      }

      const message = await readDeepSeekMessage(response, input.onStreamEvent)
      const toolCalls = message?.tool_calls?.filter((toolCall) => toolCall.function?.name)
      if (toolCalls?.length) {
        return parseAgentToolCalls(toolCalls, input, messages, message)
      }

      const content = message?.content?.trim()
      if (!content) {
        return {
          type: 'assistant_message',
          source: 'fallback',
          content: input.deterministicAnswer,
          error: 'DeepSeek agent turn returned an empty answer.',
        }
      }

      return parseAgentTurnResult(content, input.deterministicAnswer)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error
      }

      const message = error instanceof Error ? error.message : String(error)
      return {
        type: 'assistant_message',
        source: 'fallback',
        content: input.deterministicAnswer,
        error: `DeepSeek agent turn failed: ${message}.`,
      }
    }
  }

  async generateFinalAnswer(input: GenerateFinalAnswerInput): Promise<ModelAnswer> {
    if (!this.config.apiKey) {
      return fallback(input, 'Missing VITE_DEEPSEEK_API_KEY.')
    }

    try {
      const response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: buildMessages(input),
          thinking: {
            type: 'enabled',
          },
          reasoning_effort: 'high',
          stream: true,
        }),
        signal: input.signal,
      })

      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        return fallback(input, `DeepSeek API returned ${response.status}${detail ? `: ${detail}` : ''}.`)
      }

      const message = await readDeepSeekMessage(response)
      const content = message?.content?.trim()

      if (!content) {
        return fallback(input, 'DeepSeek API returned an empty answer.')
      }

      return {
        source: 'deepseek',
        content,
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error
      }

      const message = error instanceof Error ? error.message : String(error)
      return fallback(input, `DeepSeek API request failed: ${message}.`)
    }
  }

  // M2.1/M2.3: incremental structured summarization. Unlike the agent-turn /
  // final-answer paths, this REJECTS on failure (missing key, non-OK, empty,
  // network) so the caller (runSummaryCompression) degrades by NOT advancing the
  // cursor. AbortError still propagates unchanged.
  async summarize(input: SummarizeInput): Promise<SummarizeResult> {
    if (!this.config.apiKey) {
      throw new Error('DeepSeek summarize unavailable: missing VITE_DEEPSEEK_API_KEY.')
    }

    const response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: buildSummarizeMessages(input),
        thinking: { type: 'enabled' },
        reasoning_effort: 'high',
        temperature: 0,
        stream: true,
      }),
      signal: input.signal,
    }).catch((error) => {
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`DeepSeek summarize request failed: ${message}.`)
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`DeepSeek summarize returned ${response.status}${detail ? `: ${detail}` : ''}.`)
    }

    const message = await readDeepSeekMessage(response)
    const summary = message?.content?.trim()
    if (!summary) {
      throw new Error('DeepSeek summarize returned an empty summary.')
    }

    return { source: 'deepseek', summary }
  }
}

async function readDeepSeekMessage(
  response: Response,
  onStreamEvent?: (event: ModelStreamEvent) => void,
): Promise<DeepSeekAssistantMessage | undefined> {
  if (!response.body) {
    const payload = (await response.json()) as DeepSeekChatResponse
    return payload.choices?.[0]?.message
  }

  return readDeepSeekStream(response.body, onStreamEvent)
}

async function readDeepSeekStream(
  stream: ReadableStream<Uint8Array>,
  onStreamEvent?: (event: ModelStreamEvent) => void,
): Promise<DeepSeekAssistantMessage> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const message: DeepSeekAssistantMessage = {
    role: 'assistant',
    content: '',
    reasoning_content: '',
  }
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''

    for (const frame of frames) {
      applySseFrame(message, frame, onStreamEvent)
    }

    if (done) {
      if (buffer.trim()) applySseFrame(message, buffer, onStreamEvent)
      break
    }
  }

  if (!message.tool_calls?.length) delete message.tool_calls
  return message
}

function applySseFrame(
  message: DeepSeekAssistantMessage,
  frame: string,
  onStreamEvent?: (event: ModelStreamEvent) => void,
) {
  const data = frame
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n')

  if (!data || data === '[DONE]') return

  const chunk = JSON.parse(data) as DeepSeekStreamChunk
  const delta = chunk.choices?.[0]?.delta
  if (!delta) return

  if (delta.reasoning_content) {
    message.reasoning_content = `${message.reasoning_content ?? ''}${delta.reasoning_content}`
    onStreamEvent?.({
      type: 'reasoning',
      content: delta.reasoning_content,
    })
  }
  if (delta.content) {
    message.content = `${message.content ?? ''}${delta.content}`
    onStreamEvent?.({
      type: 'content',
      content: delta.content,
    })
  }
  if (delta.tool_calls?.length) {
    message.tool_calls ??= []
    for (const toolCallDelta of delta.tool_calls) {
      const index = toolCallDelta.index ?? message.tool_calls.length
      const existing = message.tool_calls[index] ?? {
        id: '',
        type: 'function' as const,
        function: {
          name: '',
          arguments: '',
        },
      }

      message.tool_calls[index] = {
        id: toolCallDelta.id ?? existing.id,
        type: toolCallDelta.type ?? existing.type,
        function: {
          name: toolCallDelta.function?.name ?? existing.function?.name ?? '',
          arguments: `${existing.function?.arguments ?? ''}${toolCallDelta.function?.arguments ?? ''}`,
        },
      }
      onStreamEvent?.({
        type: 'tool_call',
        index,
        id: message.tool_calls[index].id,
        name: message.tool_calls[index].function?.name,
        argumentsDelta: toolCallDelta.function?.arguments,
        arguments: message.tool_calls[index].function?.arguments,
      })
    }
  }
}

function buildAgentTurnMessages(input: AgentTurnInput): DeepSeekMessage[] {
  const continuedMessages = buildContinuationMessages(input)
  if (continuedMessages) return continuedMessages

  const toolNames = input.availableTools.map((tool) => tool.name)
  const toolManifest = input.availableTools.map(({ name, description, runtime }) => ({
    name,
    description,
    runtime,
  }))
  const loadedToolNames = input.loadedTools.map((tool) => tool.name)
  const loadedToolSchemaNames = input.loadedTools.map((tool) => ({
    name: tool.name,
  }))

  const baseSystem = [
    '你是 Web Agent Runtime 的当前 agent turn。',
    '你运行在支持 lazy tools 的 Web Agent Runtime 中。',
    '你可以像普通 assistant 一样直接回复用户。',
    '“工具清单”只是可用能力名称，不代表这些名称已经是本轮可调用 function。',
    '只有 API tools 字段中暴露的 function 可以直接调用；未加载 schema 的工具只能通过 request_tool_schema 请求加载。',
    '如果当前任务需要某个工具能力，而该工具 schema 尚未加载，调用 request_tool_schema 选择工具名并说明原因。',
    '如果任务需要 runtime 状态变化、暂停等待用户、结构化收集输入、浏览器侧动作或委托执行，选择工具清单中匹配的能力；普通文本只用于不需要工具的回复。',
    '当用户要求你提问、确认、收集答案、等待选择，或任务本身需要暂停 runtime 等待用户输入时，这属于工具能力选择问题；如果清单里有匹配能力，先按 lazy schema 协议加载并调用它。',
    '如果用户已经补充答案，本轮必须优先基于这些答案继续执行；不要因为原始用户输入里包含“问我”或“确认”而再次暂停。',
    '只有出现用户补充答案中完全没有覆盖、且会阻塞继续执行的新信息缺口时，才可以再次选择结构化提问能力。',
    '普通 assistant 文本不会改变 runtime 状态，也不会暂停运行或执行浏览器动作。',
    '如果相关工具 schema 已经加载，可以调用对应 function；也可以不调用工具，直接给用户回复。',
    '不要在普通文本里模拟工具调用、工具参数或工具结果。',
    '工具名必须来自工具清单。',
  ].join('\n')

  const summary = input.conversationContext?.summary?.trim()

  // M1.4: expand the eligible prior-run history between the system instruction
  // and the current-run user message. MT2: filter to non-empty user/assistant
  // messages FIRST so `hasMemory` reflects what actually gets injected — a direct
  // adapter passing only system/empty entries yields no history (and no guidance).
  const historyMessages: DeepSeekMessage[] = (input.conversationContext?.recentMessages ?? [])
    .filter(
      (message) =>
        (message.role === 'user' || message.role === 'assistant') && Boolean(message.content.trim()),
    )
    .map((message) =>
      message.role === 'assistant'
        ? { role: 'assistant', content: message.content }
        : { role: 'user', content: message.content },
    )

  // M1.4 / §1.8: only append the summary when it is non-empty — when there is no
  // memory the system text stays byte-identical to the pre-feature baseline.
  // M3.2 (§1.8): the "不确定就 ask" guidance is injected ONLY when there is memory
  // (a non-empty summary OR actual injected history). MT2: use the FILTERED
  // history length so noise-only recentMessages do not falsely trigger it.
  const hasMemory = Boolean(summary) || historyMessages.length > 0
  const systemContent = [
    baseSystem,
    summary ? `先前对话摘要：${summary}` : undefined,
    hasMemory
      ? '当你依赖的历史或摘要信息模糊、缺失，且这会改变你的答案时，优先调用 ask_user_question 向用户澄清，不要基于残缺记忆硬答；若该工具 schema 尚未加载，先按 lazy schema 协议（request_tool_schema）请求加载。'
      : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n')

  return [
    {
      role: 'system',
      content: systemContent,
    },
    ...historyMessages,
    {
      role: 'user',
      content: [
        `用户输入：${input.userInput}`,
        input.answerContext ? `用户已经补充：${JSON.stringify(input.answerContext)}` : '用户尚未补充。',
        `已加载 skills：${input.loadedSkills.join(', ') || 'none'}`,
        `工具清单（仅摘要，schema 未加载）：${toolManifest.length ? JSON.stringify(toolManifest) : 'none'}`,
        `已加载工具：${loadedToolNames.join(', ') || 'none'}`,
        `已加载工具 schema 名称：${loadedToolSchemaNames.length ? JSON.stringify(loadedToolSchemaNames) : 'none'}`,
        `worker signals：${JSON.stringify(createAgentTurnSignals(input.artifacts))}`,
      ].join('\n'),
    },
  ]
}

function buildContinuationMessages(input: AgentTurnInput): DeepSeekMessage[] | undefined {
  if (!input.continuation || input.continuation.provider !== 'deepseek') return undefined
  const state = input.continuation.state as Partial<DeepSeekContinuationState>
  if (!Array.isArray(state.messages)) return undefined

  const toolResults = input.toolResults?.length ? input.toolResults : input.toolResult ? [input.toolResult] : []
  if (!toolResults.length) return undefined

  const pendingToolCalls =
    state.pendingToolCalls ??
    (typeof state.pendingToolCallId === 'string'
      ? [
          {
            id: state.pendingToolCallId,
            name: state.pendingToolName ?? '',
            toolName: state.pendingToolName ?? '',
          },
        ]
      : [])
  if (!pendingToolCalls.length) return undefined

  return [
    ...state.messages,
    ...pendingToolCalls.map((pendingToolCall, index) => {
      const result =
        toolResults.find((toolResult) => toolResult.toolCallId === pendingToolCall.id) ??
        toolResults.find((toolResult) => toolResult.toolName === pendingToolCall.toolName) ??
        toolResults[index]

      return {
        role: 'tool' as const,
        tool_call_id: pendingToolCall.id,
        content: result?.content ?? formatMissingContinuationToolResult(pendingToolCall.toolName),
      }
    }),
  ]
}

function buildAgentTurnTools(input: AgentTurnInput) {
  const toolNames = input.availableTools.map((tool) => tool.name)
  return [
    {
      type: 'function',
      function: {
        name: 'request_tool_schema',
        description: 'Request the runtime to lazy-load the JSON schema for one available tool.',
        parameters: {
          type: 'object',
          properties: {
            toolName: {
              type: 'string',
              enum: toolNames,
            },
            reason: {
              type: 'string',
            },
          },
          required: ['toolName', 'reason'],
        },
      },
    },
    ...input.loadedTools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    })),
  ]
}

function createAgentTurnSignals(artifacts: AgentArtifact[]) {
  return artifacts.map(({ agentId, summary, findings, confidence }) => ({
    agentId,
    summary,
    findings,
    confidence,
  }))
}

function parseAgentToolCalls(
  toolCalls: DeepSeekToolCall[],
  input: AgentTurnInput,
  messages: DeepSeekMessage[],
  message: DeepSeekAssistantMessage | undefined,
): AgentTurnResult {
  const continuation = createDeepSeekContinuation(messages, message)
  const requests = toolCalls.map(parseToolSchemaRequest).filter((request): request is AgentTurnToolRequest => Boolean(request))
  if (requests.length === toolCalls.length && continuation) {
    if (requests.length === 1) {
      return {
        type: 'tool_request',
        toolName: requests[0].toolName,
        reason: requests[0].reason,
        toolCallId: requests[0].toolCallId,
        continuation,
      }
    }

    return {
      type: 'tool_requests',
      requests,
      continuation,
    }
  }

  const payloads = toolCalls
    .map((toolCall) => parseLoadedToolPayload(toolCall, input))
    .filter((payload): payload is AgentTurnToolPayload => Boolean(payload))
  if (payloads.length === toolCalls.length && continuation) {
    if (payloads.length === 1) {
      return {
        type: 'tool_payload',
        toolName: payloads[0].toolName,
        payload: payloads[0].payload,
        toolCallId: payloads[0].toolCallId,
        continuation,
      }
    }

    return {
      type: 'tool_payloads',
      calls: payloads,
      continuation,
    }
  }

  const firstName = toolCalls[0]?.function?.name
  return {
    type: 'assistant_message',
    source: 'fallback',
    content: input.deterministicAnswer,
    error: `Model returned unsupported tool call${firstName ? `: ${firstName}` : ''}.`,
  }
}

function parseToolSchemaRequest(toolCall: DeepSeekToolCall): AgentTurnToolRequest | undefined {
  const name = toolCall.function?.name
  const args = parseToolArguments(toolCall.function?.arguments)

  if (name === 'request_tool_schema') {
    const toolName = args && typeof args.toolName === 'string' ? args.toolName : undefined
    if (toolName) {
      return {
        toolName,
        reason: args && typeof args.reason === 'string' ? args.reason : 'Model requested tool schema.',
        toolCallId: toolCall.id,
      }
    }
  }

  return undefined
}

function parseLoadedToolPayload(toolCall: DeepSeekToolCall, input: AgentTurnInput): AgentTurnToolPayload | undefined {
  const name = toolCall.function?.name
  const args = parseToolArguments(toolCall.function?.arguments)

  if (name === 'ask_user_question') {
    const payload = args && 'payload' in args ? (args.payload as AskUserQuestionPayload) : (args as AskUserQuestionPayload | undefined)
    if (payload && Array.isArray(payload.questions)) {
      return {
        toolName: 'ask_user_question',
        payload,
        toolCallId: toolCall.id,
      }
    }
  }

  if (name && input.loadedTools.some((tool) => tool.name === name)) {
    return {
      toolName: name,
      payload: args ?? {},
      toolCallId: toolCall.id,
    }
  }

  return undefined
}

function createDeepSeekContinuation(
  messages: DeepSeekMessage[],
  message: DeepSeekAssistantMessage | undefined,
): AgentTurnContinuation | undefined {
  const pendingToolCalls = message?.tool_calls
    ?.filter((toolCall) => toolCall.id && toolCall.function?.name)
    .map((toolCall) => {
      const name = toolCall.function?.name ?? ''
      const args = parseToolArguments(toolCall.function?.arguments)
      const toolName =
        name === 'request_tool_schema' && args && typeof args.toolName === 'string' ? args.toolName : name
      return {
        id: toolCall.id as string,
        name,
        toolName,
      }
    })

  if (!message || !pendingToolCalls?.length) return undefined

  return {
    provider: 'deepseek',
    state: {
      messages: [
        ...messages,
        {
          role: 'assistant',
          content: message.content ?? '',
          reasoning_content: message.reasoning_content ?? null,
          tool_calls: message.tool_calls,
        },
      ],
      pendingToolCalls,
      pendingToolCallId: pendingToolCalls[0].id,
      pendingToolName: pendingToolCalls[0].name,
    } satisfies DeepSeekContinuationState,
  }
}

function formatMissingContinuationToolResult(toolName: string) {
  return JSON.stringify({
    error: `Missing runtime result for pending tool call: ${toolName || 'unknown'}.`,
  })
}

function parseToolArguments(rawArguments: string | undefined) {
  if (!rawArguments) return undefined
  try {
    return JSON.parse(rawArguments) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function parseAgentTurnResult(content: string, deterministicAnswer: string): AgentTurnResult {
  try {
    const parsed = JSON.parse(content) as {
      type?: unknown
      toolName?: unknown
      reason?: unknown
      content?: unknown
      payload?: unknown
    }
    if (parsed.type === 'tool_request' && typeof parsed.toolName === 'string') {
      return {
        type: 'tool_request',
        toolName: parsed.toolName,
        reason: typeof parsed.reason === 'string' ? parsed.reason : 'Model requested tool.',
      }
    }

    const payload = parsed.payload as { questions?: unknown } | undefined
    if (
      parsed.type === 'tool_payload' &&
      parsed.toolName === 'ask_user_question' &&
      payload &&
      Array.isArray(payload.questions)
    ) {
      return {
        type: 'tool_payload',
        toolName: 'ask_user_question',
        payload: parsed.payload as AskUserQuestionPayload,
      }
    }

    if (parsed.type === 'tool_payload' && typeof parsed.toolName === 'string') {
      return {
        type: 'tool_payload',
        toolName: parsed.toolName,
        payload: parsed.payload ?? {},
      }
    }

    if (parsed.type === 'assistant_message' && typeof parsed.content === 'string') {
      return {
        type: 'assistant_message',
        source: 'deepseek',
        content: parsed.content,
      }
    }
  } catch {
    return {
      type: 'assistant_message',
      source: 'deepseek',
      content,
    }
  }

  return {
    type: 'assistant_message',
    source: 'fallback',
    content: deterministicAnswer,
    error: 'Model returned unsupported agent-turn JSON.',
  }
}

function buildMessages(input: GenerateFinalAnswerInput) {
  return [
    {
      role: 'system',
      content:
        '你是 Web Agent Runtime 的最终回答生成器。根据 worker artifacts 生成最终中文回答。不要暴露内部调度角色、推理过程或未发生的工具调用。',
    },
    {
      role: 'user',
      content: [
        `用户输入：${input.userInput}`,
        '',
        `已加载 skills：${input.loadedSkills.join(', ') || 'none'}`,
        `已加载 tools：${input.loadedTools.join(', ') || 'none'}`,
        '',
        input.answerContext ? `用户补充：\n${JSON.stringify(input.answerContext, null, 2)}` : '用户补充：none',
        '',
        `Worker artifacts：\n${JSON.stringify(input.artifacts, null, 2)}`,
        '',
        `确定性 fallback 草稿：\n${input.deterministicAnswer}`,
        '',
        '请输出可以直接展示在 chat 里的 Markdown 最终答案。',
      ].join('\n'),
    },
  ]
}

function fallback(input: GenerateFinalAnswerInput, error: string): ModelAnswer {
  return {
    source: 'fallback',
    content: input.deterministicAnswer,
    error,
  }
}

// M2.3: structured incremental summarization prompt. Forces the four blocks
// (用户偏好 / 已确认决策 / 关键事实·约束 / 未决事项), drops小寒暄, Chinese, and
// produces 新摘要 = summarize(previousSummary + 压缩区间).
function buildSummarizeMessages(input: SummarizeInput) {
  return [
    {
      role: 'system',
      content: [
        '你是 Web Agent Runtime 的对话记忆压缩器。',
        '把“先前摘要”与“新增对话”增量合并成一份结构化中文摘要，供后续 turn 注入。',
        '必须严格分为以下四个块，按此顺序、用这些标题输出（无内容写“无”）：',
        '【用户偏好】',
        '【已确认决策】',
        '【关键事实·约束】',
        '【未决事项】',
        '只保留对后续对话有用的信息：用户偏好、已确认的决策、关键事实与约束、尚未解决的问题。',
        '丢弃寒暄、客套、重复与无信息量的过程性语句。',
        '不要编造未出现的信息；不要输出四个块以外的任何内容。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `先前摘要：\n${input.previousSummary?.trim() ? input.previousSummary.trim() : '（无）'}`,
        '',
        '新增对话（需要并入摘要的压缩区间）：',
        input.messages.length
          ? input.messages.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`).join('\n')
          : '（无）',
        '',
        '请输出合并后的结构化摘要。',
      ].join('\n'),
    },
  ]
}
