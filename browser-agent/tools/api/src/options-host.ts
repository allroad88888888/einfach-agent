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
  query(
    input: Omit<QueryOptionsInput, 'sourceId'>,
    ctx: ApiCallContext,
  ): Promise<QueryOptionsResult>
}

export interface ApiToolsHost {
  queryOptions(input: QueryOptionsInput, ctx: ApiCallContext): Promise<QueryOptionsResult>
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
