import { DEEPSEEK_BASE_URL, PROVIDER_TRANSPORT_LIMITS } from '@einfach-agent/ai'
import type { ToolResult, WebSearchCapability } from '@einfach-agent/core/tools'

interface SearchResult {
  title: string
  url: string
  snippet: string
  summary: string
  content: string
  site_name: string | null
  site_icon: string | null
  date: string | null
  rerank_score: number
  authority: number
}

function parseResult(value: unknown): SearchResult | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result = value as Record<string, unknown>
  const strings = ['title', 'url', 'snippet', 'summary', 'content'] as const
  const nullableStrings = ['site_name', 'site_icon', 'date'] as const
  if (strings.some((key) => typeof result[key] !== 'string')
    || nullableStrings.some((key) => result[key] !== null && typeof result[key] !== 'string')
    || typeof result.rerank_score !== 'number' || !Number.isFinite(result.rerank_score)
    || !Number.isInteger(result.authority)) return undefined
  // Return only documented fields; unknown upstream fields never enter the transcript.
  return Object.fromEntries(
    [...strings, ...nullableStrings, 'rerank_score', 'authority'].map((key) => [key, result[key]]),
  ) as unknown as SearchResult
}

function failure(code: string, error: string, retryable = false): ToolResult {
  return { ok: false, code: `DEEPSEEK_SEARCH_${code}`, error, retryable }
}

async function httpFailure(response: Response): Promise<ToolResult> {
  const { status } = response
  if (status === 503) {
    const payload = await response.json().catch(() => undefined)
    if (payload?.error === 'model_credential_missing') {
      return failure('MISSING_KEY', '未配置 DeepSeek API Key，请在模型设置中配置。')
    }
  } else {
    await response.body?.cancel().catch(() => undefined)
  }
  if (status === 401) return failure('UNAUTHORIZED', 'DeepSeek API Key 无效，请检查模型设置中的 Key。')
  if (status === 402) return failure('INSUFFICIENT_BALANCE', 'DeepSeek 账号余额不足，请充值后重试。')
  return failure(
    `HTTP_${status}`,
    `DeepSeek 搜索请求失败（HTTP ${status}）。`,
    status === 408 || status === 429 || status >= 500,
  )
}

/** Reuses the app's model credential and fetch transport; never exposes either to tools. */
export function createDeepSeekSearch(options: {
  apiKey?: string
  fetchImpl?: typeof fetch
}): WebSearchCapability {
  return async (input, { signal }) => {
    if (signal.aborted) return failure('ABORTED', '搜索已取消。')
    const apiKey = options.apiKey?.trim()
    if (!apiKey) return failure('MISSING_KEY', '未配置 DeepSeek API Key，请在模型设置中配置。')
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(abort, PROVIDER_TRANSPORT_LIMITS.requestTimeoutMs)
    try {
      const response = await (options.fetchImpl ?? globalThis.fetch)(`${DEEPSEEK_BASE_URL}/v1/tools/search`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
        signal: controller.signal,
        redirect: 'error',
      })
      if (!response.ok) {
        return await httpFailure(response)
      }
      const payload: unknown = await response.json()
      if (signal.aborted) return failure('ABORTED', '搜索已取消。')
      const values = payload && typeof payload === 'object'
        ? (payload as { results?: unknown }).results : undefined
      if (!Array.isArray(values)) return failure('INVALID_RESPONSE', 'DeepSeek 搜索返回了无效的结果。')
      const results = values.map(parseResult)
      if (results.some((value) => !value)) return failure('INVALID_RESPONSE', 'DeepSeek 搜索返回了无效的结果。')
      return { ok: true, data: { results } }
    } catch (error) {
      if (signal.aborted) return failure('ABORTED', '搜索已取消。')
      if (controller.signal.aborted) return failure('TIMEOUT', 'DeepSeek 搜索超时，请重试。', true)
      if (error instanceof SyntaxError) return failure('INVALID_RESPONSE', 'DeepSeek 搜索返回了无效的 JSON。')
      // The host emits this exact credential error. Arbitrary upstream errors may contain secrets.
      if (error instanceof Error && error.message === '未配置 DeepSeek API Key') {
        return failure('MISSING_KEY', error.message)
      }
      return failure('FAILED', 'DeepSeek 搜索请求失败，请检查网络后重试。', true)
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
    }
  }
}
