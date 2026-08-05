export interface RetryConfig {
  maxRetries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  jitter?: boolean
  sleepImpl?(ms: number, signal?: AbortSignal): Promise<void>
  onRetry?(info: RetryAttemptInfo): void
}

export interface RetryAttemptInfo {
  attempt: number
  delayMs: number
  reason: string
  error: unknown
}

export const DEFAULT_RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 20_000,
  jitter: true,
} as const

export interface ResolvedRetryConfig {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  jitter: boolean
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  onRetry?(info: RetryAttemptInfo): void
}

export function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { name?: unknown }).name === 'AbortError'
}

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(createAbortError())
  if (ms <= 0) return Promise.resolve()

  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(createAbortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function resolveRetryConfig(config?: RetryConfig): ResolvedRetryConfig {
  return {
    maxRetries: Math.max(0, config?.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries),
    baseDelayMs: Math.max(0, config?.baseDelayMs ?? DEFAULT_RETRY_CONFIG.baseDelayMs),
    maxDelayMs: Math.max(0, config?.maxDelayMs ?? DEFAULT_RETRY_CONFIG.maxDelayMs),
    jitter: config?.jitter ?? DEFAULT_RETRY_CONFIG.jitter,
    sleep: config?.sleepImpl ?? defaultSleep,
    onRetry: config?.onRetry,
  }
}

export function readHeader(response: Response, name: string): string | null {
  try {
    return response.headers.get(name)
  } catch {
    return null
  }
}

const MAX_HTTP_ERROR_MESSAGE_LENGTH = 240

function httpErrorCategory(status: number): string {
  if (status === 400 || status === 422) return 'invalid_request'
  if (status === 401) return 'authentication_error'
  if (status === 403) return 'permission_error'
  if (status === 404) return 'not_found'
  if (status === 408) return 'request_timeout'
  if (status === 409) return 'conflict'
  if (status === 413) return 'payload_too_large'
  if (status === 429) return 'rate_limit'
  if (status >= 500) return 'upstream_error'
  return 'http_error'
}

function safeRequestId(response: Response): string | undefined {
  const raw = readHeader(response, 'X-Request-Id') ?? readHeader(response, 'Request-Id')
  const value = raw?.trim()
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) return undefined
  return /(?:bearer|api[-_]?key|ms:|sk-)/i.test(value) ? undefined : value
}

function summarizeHttpError(response: Response): string {
  const requestId = safeRequestId(response)
  const fields = [httpErrorCategory(response.status)]
  if (requestId) fields.push(`request_id=${requestId}`)
  // Keep the historical status prefix: Core uses it to avoid escalating deterministic 4xx
  // failures to a different model. Everything after the status is constructed locally.
  return `Chat completion returned ${response.status} (${fields.join(', ')}).`
    .slice(0, MAX_HTTP_ERROR_MESSAGE_LENGTH)
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The status and trusted headers are enough for diagnostics. Never surface body data.
  }
}

function parseRetryAfterMs(raw: string | null, nowMs: number = Date.now()): number | undefined {
  if (!raw) return undefined
  const value = raw.trim()
  if (!value) return undefined
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const seconds = Number(value)
    return Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : undefined
  }
  const targetMs = Date.parse(value)
  return Number.isNaN(targetMs) ? undefined : Math.max(0, targetMs - nowMs)
}

function computeBackoffMs(
  attempt: number,
  config: ResolvedRetryConfig,
  retryAfterMs?: number,
): number {
  if (typeof retryAfterMs === 'number') {
    return Math.min(Math.max(retryAfterMs, config.baseDelayMs), config.maxDelayMs)
  }
  const exponential = Math.min(config.baseDelayMs * 2 ** attempt, config.maxDelayMs)
  return config.jitter
    ? Math.round(exponential / 2 + Math.random() * (exponential / 2))
    : exponential
}

export class RetriableError extends Error {
  readonly retryAfterMs?: number
  readonly originalError?: unknown

  constructor(message: string, init: { retryAfterMs?: number; originalError?: unknown } = {}) {
    super(message)
    this.name = 'RetriableError'
    this.retryAfterMs = init.retryAfterMs
    this.originalError = init.originalError
  }
}

export async function withRetry<T>(
  config: ResolvedRetryConfig,
  signal: AbortSignal | undefined,
  run: (attempt: number) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run(attempt)
    } catch (error) {
      if (isAbortError(error)) throw error
      if (!(error instanceof RetriableError)) throw error
      if (attempt >= config.maxRetries) throw error.originalError ?? error
      const delayMs = computeBackoffMs(attempt, config, error.retryAfterMs)
      config.onRetry?.({
        attempt: attempt + 1,
        delayMs,
        reason: error.message,
        error: error.originalError ?? error,
      })
      await config.sleep(delayMs, signal)
    }
  }
}

/** Executes one HTTP request and classifies only transient failures as retriable. */
export async function requestOnce(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response
  try {
    response = await fetchImpl(url, init)
  } catch (error) {
    if (isAbortError(error)) throw error
    const safeError = new TypeError('Chat completion transport failed (network_error).')
    throw new RetriableError(safeError.message, {
      originalError: safeError,
    })
  }

  if (response.ok) return response
  const message = summarizeHttpError(response)
  await discardResponseBody(response)
  if (response.status === 429 || response.status >= 500) {
    throw new RetriableError(message, {
      retryAfterMs: parseRetryAfterMs(readHeader(response, 'Retry-After')),
    })
  }
  throw new Error(message)
}
