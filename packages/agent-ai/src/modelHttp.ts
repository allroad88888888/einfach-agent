import type { ChatRequestBase, ModelChatResponse } from './modelProtocol'
import {
  isAbortError,
  requestOnce,
  resolveRetryConfig,
  RetriableError,
  withRetry,
  type RetryConfig,
} from './modelRetry'
import {
  associateProviderLocalIdentity,
  isLegacyOpenAiCompat,
} from './providerLocalTransport'

export interface ChatCallOptions {
  apiKey: string
  baseUrl?: string
  /** Local adapter-to-transport association; never encoded into an HTTP request. */
  connectionId?: string
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  retry?: RetryConfig
}

export function buildJsonRequestInit(body: unknown, options: ChatCallOptions): RequestInit {
  const init: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  }
  associateProviderLocalIdentity(options.fetchImpl, init, {
    connectionId: options.connectionId,
    legacyOpenAiCompat: isLegacyOpenAiCompat(options) ? true : undefined,
  })
  return init
}

export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`
}

export function isUnexpectedEndJsonError(error: unknown): boolean {
  return error instanceof Error && /unexpected (?:end|eof)/i.test(error.message)
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch (error) {
    if (isAbortError(error)) throw error
    throw new RetriableError('Chat completion response body ended before it could be read.')
  }
}

export function parseChatResponseSource(source: string): ModelChatResponse {
  if (!source.trim()) throw new RetriableError('Chat completion returned an empty JSON response.')
  try {
    return JSON.parse(source) as ModelChatResponse
  } catch (error) {
    if (!isUnexpectedEndJsonError(error)) throw error
    throw new RetriableError('Chat completion returned a truncated JSON response.')
  }
}

export async function parseChatResponse(response: Response): Promise<ModelChatResponse> {
  return parseChatResponseSource(await readResponseText(response))
}

/** Posts one non-streaming OpenAI-compatible chat request with safe retries. */
export async function postChatCompletion(
  baseUrl: string,
  body: ChatRequestBase<unknown>,
  options: ChatCallOptions,
): Promise<ModelChatResponse> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
  const config = resolveRetryConfig(options.retry)
  const url = chatCompletionsUrl(baseUrl)
  const init = buildJsonRequestInit(body, options)
  return withRetry(config, options.signal, async () => {
    return parseChatResponse(await requestOnce(fetchImpl, url, init))
  })
}
