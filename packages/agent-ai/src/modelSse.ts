import {
  buildJsonRequestInit,
  chatCompletionsUrl,
  isUnexpectedEndJsonError,
  parseChatResponse,
  parseChatResponseSource,
  type ChatCallOptions,
} from './modelHttp'
import type {
  ChatRequestBase,
  ChatStreamHandlers,
  ModelChatResponse,
  ModelStreamDelta,
} from './modelProtocol'
import {
  isAbortError,
  readHeader,
  requestOnce,
  resolveRetryConfig,
  RetriableError,
  withRetry,
} from './modelRetry'
import { readStreamResponse } from './modelSseAccumulator'

function emitFullResponseAsDelta(response: ModelChatResponse, handlers?: ChatStreamHandlers): void {
  const message = response.choices?.[0]?.message
  if (!message) return
  handlers?.onDelta?.({
    content: message.content,
    reasoning_content: message.reasoning_content,
    tool_calls: message.tool_calls,
  })
}

function deltaCarriesContent(delta: ModelStreamDelta): boolean {
  return (typeof delta.content === 'string' && delta.content.length > 0)
    || (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0)
    || Boolean(delta.tool_calls?.length)
}

function sourceLooksLikeSse(source: string): boolean {
  const firstLine = source.trimStart().split(/\r?\n/, 1)[0] ?? ''
  return /^(?::|(?:data|event|id|retry):)/.test(firstLine)
}

function sourceMayBeSse(source: string): boolean {
  const firstLine = source.trimStart().split(/\r?\n/, 1)[0] ?? ''
  return [':', 'data:', 'event:', 'id:', 'retry:'].some((prefix) => prefix.startsWith(firstLine))
}

function streamWithInitialChunks(
  initialChunks: readonly Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < initialChunks.length) controller.enqueue(initialChunks[index++]!)
      else {
        const { done, value } = await reader.read()
        if (done) controller.close()
        else controller.enqueue(value)
      }
    },
    cancel: (reason) => reader.cancel(reason),
  })
}

async function readPossiblyMislabelledStreamResponse(
  body: ReadableStream<Uint8Array>,
  handlers?: ChatStreamHandlers,
): Promise<{ response: ModelChatResponse; streamed: boolean }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const initialChunks: Uint8Array[] = []
  let source = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return { response: parseChatResponseSource(source + decoder.decode()), streamed: false }
      initialChunks.push(value)
      source += decoder.decode(value, { stream: true })
      if (sourceLooksLikeSse(source)) {
        return {
          response: await readStreamResponse(streamWithInitialChunks(initialChunks, reader), handlers),
          streamed: true,
        }
      }
      if (!sourceMayBeSse(source) || source.length >= 64) break
    }
    while (true) {
      const { done, value } = await reader.read()
      source += decoder.decode(value, { stream: !done })
      if (done) return { response: parseChatResponseSource(source), streamed: false }
    }
  } finally {
    reader.releaseLock()
  }
}

function rethrowStreamReadError(error: unknown, emitted: boolean): never {
  if (isAbortError(error) || emitted) throw error
  if (error instanceof SyntaxError && !isUnexpectedEndJsonError(error)) throw error
  throw new RetriableError(error instanceof Error ? error.message : String(error), {
    originalError: error,
  })
}

/** Streams one OpenAI-compatible request; retries stop after the first visible delta. */
export async function postChatCompletionStream(
  baseUrl: string,
  body: ChatRequestBase<unknown>,
  options: ChatCallOptions,
  handlers: ChatStreamHandlers = {},
): Promise<ModelChatResponse> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  const config = resolveRetryConfig(options.retry)
  const url = chatCompletionsUrl(baseUrl)
  const init = buildJsonRequestInit({ ...body, stream: true }, options)
  let emitted = false
  const guardedHandlers: ChatStreamHandlers = {
    onDelta(delta) {
      if (deltaCarriesContent(delta)) emitted = true
      handlers.onDelta?.(delta)
    },
  }

  return withRetry(config, options.signal, async () => {
    const response = await requestOnce(fetchImpl, url, init)
    const contentType = readHeader(response, 'Content-Type') ?? ''
    if (contentType.includes('text/event-stream') && response.body) {
      try {
        return await readStreamResponse(response.body, guardedHandlers)
      } catch (error) {
        rethrowStreamReadError(error, emitted)
      }
    }
    if (response.body) {
      try {
        const result = await readPossiblyMislabelledStreamResponse(response.body, guardedHandlers)
        if (!result.streamed) emitFullResponseAsDelta(result.response, guardedHandlers)
        return result.response
      } catch (error) {
        rethrowStreamReadError(error, emitted)
      }
    }
    const full = await parseChatResponse(response)
    emitFullResponseAsDelta(full, guardedHandlers)
    return full
  })
}
