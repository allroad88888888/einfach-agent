import type {
  ChatStreamHandlers,
  ModelChatResponse,
  ModelChatStreamChunk,
  ModelResponseMessage,
  ModelResponseToolCall,
  ModelStreamDelta,
  ModelUsage,
} from './modelProtocol'

interface StreamAccumulator {
  id?: string
  model?: string
  content: string
  reasoningContent: string
  toolCalls: Map<number, ModelResponseToolCall>
  finishReason?: string | null
  usage?: ModelUsage
}

function appendToolCallDelta(
  toolCalls: StreamAccumulator['toolCalls'],
  delta: ModelResponseToolCall,
  fallbackIndex: number,
): void {
  const index = typeof delta.index === 'number' ? delta.index : fallbackIndex
  const current = toolCalls.get(index) ?? {
    index,
    type: 'function' as const,
    function: { arguments: '' },
  }
  if (delta.id) current.id = delta.id
  if (delta.type) current.type = delta.type
  if (delta.function) {
    const currentFunction = current.function ?? {}
    if (typeof delta.function.name === 'string') currentFunction.name = delta.function.name
    if (typeof delta.function.arguments === 'string') {
      currentFunction.arguments = `${currentFunction.arguments ?? ''}${delta.function.arguments}`
    }
    current.function = currentFunction
  }
  toolCalls.set(index, current)
}

function applyStreamDelta(acc: StreamAccumulator, delta: ModelStreamDelta): void {
  if (typeof delta.content === 'string') acc.content += delta.content
  if (typeof delta.reasoning_content === 'string') acc.reasoningContent += delta.reasoning_content
  delta.tool_calls?.forEach((toolCall, index) => appendToolCallDelta(acc.toolCalls, toolCall, index))
}

function toChatResponse(acc: StreamAccumulator): ModelChatResponse {
  const toolCalls = [...acc.toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, toolCall]) => toolCall)
  const message: ModelResponseMessage = {
    role: 'assistant',
    content: acc.content.length > 0 ? acc.content : null,
  }
  if (acc.reasoningContent.length > 0) message.reasoning_content = acc.reasoningContent
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  const response: ModelChatResponse = {
    choices: [{
      finish_reason: acc.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      message,
    }],
  }
  if (acc.id !== undefined) response.id = acc.id
  if (acc.model !== undefined) response.model = acc.model
  if (acc.usage) response.usage = acc.usage
  return response
}

function eventDataFromSseBlock(block: string): string | undefined {
  const dataLines: string[] = []
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  return dataLines.length > 0 ? dataLines.join('\n') : undefined
}

function consumeSseBuffer(
  buffer: string,
  acc: StreamAccumulator,
  handlers?: ChatStreamHandlers,
): { rest: string; done: boolean } {
  let rest = buffer.replace(/\r\n/g, '\n')
  while (true) {
    const boundary = rest.indexOf('\n\n')
    if (boundary < 0) return { rest, done: false }
    const block = rest.slice(0, boundary)
    rest = rest.slice(boundary + 2)
    const data = eventDataFromSseBlock(block)
    if (!data) continue
    if (data === '[DONE]') return { rest, done: true }
    const chunk = JSON.parse(data) as ModelChatStreamChunk
    if (typeof chunk.id === 'string' && acc.id === undefined) acc.id = chunk.id
    if (typeof chunk.model === 'string' && acc.model === undefined) acc.model = chunk.model
    if (chunk.usage) acc.usage = { ...acc.usage, ...chunk.usage }
    const choice = chunk.choices?.[0]
    if (choice?.delta) {
      handlers?.onDelta?.(choice.delta)
      applyStreamDelta(acc, choice.delta)
    }
    if (choice?.finish_reason) acc.finishReason = choice.finish_reason
  }
}

class TruncatedStreamError extends Error {
  constructor() {
    super('Chat completion stream ended before [DONE].')
    this.name = 'TruncatedStreamError'
  }
}

export async function readStreamResponse(
  body: ReadableStream<Uint8Array>,
  handlers?: ChatStreamHandlers,
): Promise<ModelChatResponse> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const acc: StreamAccumulator = { content: '', reasoningContent: '', toolCalls: new Map() }
  let buffer = ''
  let sawDone = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const consumed = consumeSseBuffer(buffer, acc, handlers)
      buffer = consumed.rest
      if (consumed.done) {
        sawDone = true
        break
      }
      if (done) {
        if (buffer.trim()) {
          const trailing = consumeSseBuffer(`${buffer}\n\n`, acc, handlers)
          sawDone = trailing.done
        }
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
  if (!sawDone) throw new TruncatedStreamError()
  return toChatResponse(acc)
}
