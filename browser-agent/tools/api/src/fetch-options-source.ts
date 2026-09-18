import { ApiToolsError } from './api-error'
import type { ApiCallContext, OptionsSource, QueryOptionsInput, QueryOptionsResult } from './options-host'

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface HttpQueryRequest {
  url: string
  init?: RequestInit
}

export interface FetchOptionsSourceConfig {
  id: string
  request(input: Omit<QueryOptionsInput, 'sourceId'>): HttpQueryRequest
  mapResponse(payload: unknown): QueryOptionsResult
  fetch?: FetchLike
}

/** Builds one allowlisted read-only source. Request details remain host-owned. */
export function createFetchOptionsSource(config: FetchOptionsSourceConfig): OptionsSource {
  const fetcher = config.fetch ?? globalThis.fetch
  if (typeof fetcher !== 'function') {
    throw new ApiToolsError('API_OPTIONS_NETWORK_ERROR', 'options fetch is unavailable')
  }
  return {
    id: config.id,
    async query(input, ctx) {
      try {
        const request = config.request(input)
        const response = await fetcher(request.url, { ...request.init, signal: ctx.signal })
        if (!response.ok) throw httpError(response.status)
        let payload: unknown
        try {
          payload = await response.json()
        } catch {
          throw new ApiToolsError('API_OPTIONS_INVALID_RESPONSE', 'options source returned invalid JSON')
        }
        try {
          return config.mapResponse(payload)
        } catch (error) {
          if (error instanceof ApiToolsError) throw error
          throw new ApiToolsError('API_OPTIONS_INVALID_RESPONSE', 'options source returned an invalid response')
        }
      } catch (error) {
        if (error instanceof ApiToolsError) throw error
        if (ctx.signal.aborted || isAbortError(error)) {
          throw new ApiToolsError('API_OPTIONS_CANCELLED', 'options query was cancelled')
        }
        throw new ApiToolsError('API_OPTIONS_NETWORK_ERROR', 'options source request failed', true)
      }
    },
  }
}

function httpError(status: number): ApiToolsError {
  if (status === 401 || status === 403) return new ApiToolsError('API_OPTIONS_UNAUTHORIZED', 'options source authorization failed')
  if (status === 408 || status === 504) return new ApiToolsError('API_OPTIONS_TIMEOUT', 'options source timed out', true)
  if (status === 429) return new ApiToolsError('API_OPTIONS_RATE_LIMITED', 'options source is rate limited', true)
  return new ApiToolsError('API_OPTIONS_SERVICE_ERROR', 'options source request failed', status >= 500)
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError'
}
