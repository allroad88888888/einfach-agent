import type { ToolContext } from '@einfach-agent/core/tools'
import { ApiToolsError, type ApiToolsErrorCode } from './api-error'
import { runQueryWithDeadline } from './query-lifecycle'

export { ApiToolsError, type ApiToolsErrorCode } from './api-error'

export const MAX_OPTIONS = 100
export const DEFAULT_QUERY_TIMEOUT_MS = 10_000
export const MAX_QUERY_TIMEOUT_MS = 120_000
const MAX_TEXT_LENGTH = 500
const MAX_PARAMETERS = 50

export interface QueryOption {
  label: string
  value: string
}

export interface QueryOptionsInput {
  sourceId: string
  query?: string
  cursor?: string
  parameters?: Readonly<Record<string, string | number | boolean>>
}

export interface QueryOptionsResult {
  options: readonly QueryOption[]
  nextCursor?: string
  /** True when the host limited a source response to MAX_OPTIONS. */
  truncated?: boolean
}

export type ApiCallContext = Pick<ToolContext, 'sessionId' | 'signal'>

export interface OptionsSource {
  id: string
  /** Display-only metadata. Request details remain private to the host adapter. */
  label?: string
  description?: string
  query(
    input: Omit<QueryOptionsInput, 'sourceId'>,
    ctx: ApiCallContext,
  ): Promise<QueryOptionsResult>
}

export interface ApiToolsHost {
  queryOptions(input: QueryOptionsInput, ctx: ApiCallContext): Promise<QueryOptionsResult>
  listSources?(input: ListOptionsSourcesInput, ctx: ApiCallContext): Promise<ListOptionsSourcesResult>
}

export interface OptionsSourceInfo {
  id: string
  label?: string
  description?: string
}

export interface ListOptionsSourcesInput {
  offset?: number
  limit?: number
}

export interface ListOptionsSourcesResult {
  sources: readonly OptionsSourceInfo[]
  nextOffset?: number
}

export interface ApiToolsHostOptions {
  isSourceAllowed(sourceId: string, sessionId: string): boolean
  /** Host-controlled deadline for source, fetch, and response-body work. */
  timeoutMs?: number
}

export function createApiToolsHost(
  sources: readonly OptionsSource[],
  options: ApiToolsHostOptions,
): ApiToolsHost {
  const timeoutMs = normalizeTimeout(options.timeoutMs)
  const registered = new Map<string, OptionsSource>()
  for (const source of sources) {
    if (!source.id.trim() || registered.has(source.id)) {
      throw new ApiToolsError('API_OPTIONS_INVALID_INPUT', 'duplicate or empty options source id')
    }
    registered.set(source.id, source)
  }

  return {
    async queryOptions(input, ctx) {
      validateInput(input)
      const source = registered.get(input.sourceId)
      if (!source) throw new ApiToolsError('API_OPTIONS_UNKNOWN_SOURCE', 'options source is not registered')
      if (!options.isSourceAllowed(input.sourceId, ctx.sessionId)) {
        throw new ApiToolsError('API_OPTIONS_FORBIDDEN', 'options source is not allowed for this session')
      }
      const result = await runQueryWithDeadline(
        (sourceContext) => source.query(withoutSourceId(input), sourceContext),
        ctx,
        timeoutMs,
      )
      return normalizeResult(result)
    },
    async listSources(input, ctx) {
      validateListInput(input)
      if (ctx.signal.aborted) {
        throw new ApiToolsError('API_OPTIONS_CANCELLED', 'options query was cancelled')
      }
      const authorized: OptionsSourceInfo[] = []
      for (const source of registered.values()) {
        let allowed: boolean
        try {
          allowed = options.isSourceAllowed(source.id, ctx.sessionId)
        } catch {
          throw new ApiToolsError('API_OPTIONS_FORBIDDEN', 'options source is not allowed for this session')
        }
        if (allowed) authorized.push(sourceInfo(source))
      }
      const offset = input.offset ?? 0
      const limit = input.limit ?? 20
      const page = authorized.slice(offset, offset + limit)
      const nextOffset = offset + page.length
      return {
        sources: page,
        ...(nextOffset < authorized.length ? { nextOffset } : {}),
      }
    },
  }
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_QUERY_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_QUERY_TIMEOUT_MS) {
    throw new ApiToolsError('API_OPTIONS_INVALID_INPUT', 'invalid options source timeout')
  }
  return timeoutMs
}

function withoutSourceId(input: QueryOptionsInput): Omit<QueryOptionsInput, 'sourceId'> {
  const { sourceId: _sourceId, ...sourceInput } = input
  return sourceInput
}

function validateInput(input: QueryOptionsInput): void {
  if (!isShortText(input.sourceId)) invalidInput()
  if (input.query !== undefined && !isShortText(input.query)) invalidInput()
  if (input.cursor !== undefined && !isShortText(input.cursor)) invalidInput()
  if (input.parameters !== undefined) {
    const entries = Object.entries(input.parameters)
    if (entries.length > MAX_PARAMETERS || entries.some(([key, value]) => !isShortText(key) || !isParameter(value))) {
      invalidInput()
    }
  }
}

function validateListInput(input: ListOptionsSourcesInput): void {
  if (!isListInput(input) || !isPageInteger(input.offset) || !isPageInteger(input.limit) || (input.limit !== undefined && (input.limit < 1 || input.limit > MAX_OPTIONS))) {
    throw new ApiToolsError('API_OPTIONS_INVALID_INPUT', 'invalid list_options_sources input')
  }
}

function isListInput(input: unknown): input is ListOptionsSourcesInput {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}

function isPageInteger(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
}

function sourceInfo(source: OptionsSource): OptionsSourceInfo {
  const label = metadataText(source.label)
  const description = metadataText(source.description)
  return {
    id: source.id,
    ...(label === undefined ? {} : { label }),
    ...(description === undefined ? {} : { description }),
  }
}

function metadataText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= MAX_TEXT_LENGTH ? value : undefined
}

function isShortText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_TEXT_LENGTH
}

function isParameter(value: unknown): value is string | number | boolean {
  return typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.length <= MAX_TEXT_LENGTH)
}

function invalidInput(): never {
  throw new ApiToolsError('API_OPTIONS_INVALID_INPUT', 'invalid query_options input')
}

function normalizeResult(result: QueryOptionsResult): QueryOptionsResult {
  if (!result || !Array.isArray(result.options)) invalidResponse()
  const options = result.options.map(normalizeOption)
  if (result.nextCursor !== undefined && !isShortText(result.nextCursor)) invalidResponse()
  const truncated = options.length > MAX_OPTIONS || result.truncated === true
  return {
    options: options.slice(0, MAX_OPTIONS),
    ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
    ...(truncated ? { truncated: true } : {}),
  }
}

function normalizeOption(option: QueryOption): QueryOption {
  if (!option || !isShortText(option.label) || !isShortText(option.value)) invalidResponse()
  return { label: option.label, value: option.value }
}

function invalidResponse(): never {
  throw new ApiToolsError('API_OPTIONS_INVALID_RESPONSE', 'options source returned an invalid response')
}
