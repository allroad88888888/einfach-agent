import {
  buildJsonRequestInit,
  isUnexpectedEndJsonError,
  type ChatCallOptions,
} from './modelHttp'
import type { ChatStreamHandlers, ModelChatResponse, ModelStreamDelta } from './modelProtocol'
import {
  readHeader,
  requestOnce,
  resolveRetryConfig,
  RetriableError,
  withRetry,
} from './modelRetry'
import type { DeepSeekResponsesRequest } from './deepseekResponsesProtocol'
import {
  deepSeekResponseAsChat,
  deepSeekResponseDelta,
  type DeepSeekResponsePayload,
} from './deepseekResponsesResult'

interface ResponsesStreamEvent {
  type?: string
  delta?: string
  response?: DeepSeekResponsePayload
}

function responsesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/responses`
}

function parsePayload(source: string): DeepSeekResponsePayload {
  if (!source.trim()) throw new RetriableError('DeepSeek Responses returned an empty JSON response.')
  try {
    return JSON.parse(source) as DeepSeekResponsePayload
  } catch (error) {
    if (!isUnexpectedEndJsonError(error)) throw error
    throw new RetriableError('DeepSeek Responses returned a truncated JSON response.')
  }
}

function assertUsablePayload(payload: DeepSeekResponsePayload): void {
  if (payload.status === 'failed') {
    // The provider message is untrusted and can contain echoed request data. Keep the error stable.
    throw new Error('DeepSeek Responses failed (response_failed).')
  }
}

async function readPayload(response: Response): Promise<DeepSeekResponsePayload> {
  try {
    return parsePayload(await response.text())
  } catch (error) {
    if (error instanceof RetriableError || error instanceof SyntaxError) throw error
    throw new RetriableError('DeepSeek Responses ended before its body could be read.')
  }
}

function eventBlock(block: string): ResponsesStreamEvent | undefined {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  return data ? JSON.parse(data) as ResponsesStreamEvent : undefined
}

function deltaFromEvent(event: ResponsesStreamEvent): ModelStreamDelta | undefined {
  if (typeof event.delta !== 'string') return undefined
  if (event.type === 'response.output_text.delta') return { content: event.delta }
  if (event.type === 'response.reasoning_text.delta') return { reasoning_content: event.delta }
  return undefined
}

function consumeBlocks(
  source: string,
  handlers: ChatStreamHandlers,
): { rest: string; terminal?: DeepSeekResponsePayload; emitted: boolean } {
  let rest = source.replace(/\r\n/g, '\n')
  let emitted = false
  while (true) {
    const boundary = rest.indexOf('\n\n')
    if (boundary < 0) return { rest, emitted }
    const block = rest.slice(0, boundary)
    rest = rest.slice(boundary + 2)
    const event = eventBlock(block)
    if (!event) continue
    const delta = deltaFromEvent(event)
    if (delta) {
      handlers.onDelta?.(delta)
      emitted = true
    }
    if (event.type === 'response.completed'
      || event.type === 'response.incomplete'
      || event.type === 'response.failed') {
      if (!event.response) throw new Error('DeepSeek Responses terminal event has no response.')
      return { rest, terminal: event.response, emitted }
    }
  }
}

async function readStream(
  body: ReadableStream<Uint8Array>,
  handlers: ChatStreamHandlers,
): Promise<{ payload: DeepSeekResponsePayload; emitted: boolean }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let emitted = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const consumed = consumeBlocks(done && buffer.trim() ? `${buffer}\n\n` : buffer, handlers)
      buffer = consumed.rest
      emitted ||= consumed.emitted
      if (consumed.terminal) return { payload: consumed.terminal, emitted }
      if (done) throw new RetriableError('DeepSeek Responses stream ended before a terminal event.')
    }
  } finally {
    reader.releaseLock()
  }
}

/** Sends one non-streaming DeepSeek Responses request. */
export function postDeepSeekResponse(
  baseUrl: string,
  body: DeepSeekResponsesRequest,
  options: ChatCallOptions,
): Promise<ModelChatResponse> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  const config = resolveRetryConfig(options.retry)
  const init = buildJsonRequestInit({ ...body, stream: false }, options)
  return withRetry(config, options.signal, async () => {
    const response = await requestOnce(fetchImpl, responsesUrl(baseUrl), init)
    const payload = await readPayload(response)
    assertUsablePayload(payload)
    return deepSeekResponseAsChat(payload)
  })
}

/** Streams semantic Responses events through the existing chat-shaped Core boundary. */
export async function postDeepSeekResponseStream(
  baseUrl: string,
  body: DeepSeekResponsesRequest,
  options: ChatCallOptions,
  handlers: ChatStreamHandlers = {},
): Promise<ModelChatResponse> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  const config = resolveRetryConfig(options.retry)
  let emitted = false
  return withRetry(config, options.signal, async () => {
    const response = await requestOnce(
      fetchImpl,
      responsesUrl(baseUrl),
      buildJsonRequestInit({ ...body, stream: true }, options),
    )
    const contentType = readHeader(response, 'Content-Type') ?? ''
    if (!contentType.includes('text/event-stream') || !response.body) {
      const payload = await readPayload(response)
      assertUsablePayload(payload)
      const delta = deepSeekResponseDelta(payload)
      handlers.onDelta?.(delta)
      emitted = true
      return deepSeekResponseAsChat(payload)
    }
    const trackedHandlers: ChatStreamHandlers = {
      ...handlers,
      onDelta(delta) {
        emitted = true
        handlers.onDelta?.(delta)
      },
    }
    try {
      const result = await readStream(response.body, trackedHandlers)
      emitted ||= result.emitted
      assertUsablePayload(result.payload)
      if (!result.emitted) trackedHandlers.onDelta?.(deepSeekResponseDelta(result.payload))
      return deepSeekResponseAsChat(result.payload)
    } catch (error) {
      if (emitted && error instanceof RetriableError) {
        throw error.originalError ?? new Error(error.message)
      }
      throw error
    }
  })
}
