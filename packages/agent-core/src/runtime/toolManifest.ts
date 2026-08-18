// 产出当前环境可发现的工具清单：稳定前缀里的全量文本，或 request_tool_schema 用的有界分页。
// ---------------------------------------------------------------------------
// 两种投影共用 turnToolVisibility 的目录视图，保证「清单里写着的」与「能加载的」判据一致；
// 两者都只含 name/description/runtime，inputSchema 与 guide 仍只能经 request_tool_schema 懒加载。

import type { ToolSummary } from '../tools/types'
import { fnv1a32 } from './shared/hash'
import {
  availableToolSummaries,
  type BuildTurnToolsOptions,
} from './turnToolVisibility'

export const DEFAULT_TOOL_MANIFEST_PAGE_SIZE = 16
export const MAX_TOOL_MANIFEST_PAGE_SIZE = 32
export const MAX_TOOL_MANIFEST_QUERY_LENGTH = 128

export interface ToolManifestSearchInput {
  query?: string
  cursor?: string
  limit?: number
}

export interface ToolManifestPage {
  kind: 'tool_manifest_page'
  query: string
  items: ToolSummary[]
  total: number
  limit: number
  hasMore: boolean
  nextCursor?: string
}

export interface ToolManifestError {
  kind: 'tool_manifest_error'
  code: 'invalid_cursor' | 'stale_cursor' | 'query_too_long'
  error: string
  restart: {
    query: string
    limit: number
  }
}

export type ToolManifestResult = ToolManifestPage | ToolManifestError

function normalizedManifestLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_TOOL_MANIFEST_PAGE_SIZE
  }
  return Math.max(1, Math.min(MAX_TOOL_MANIFEST_PAGE_SIZE, Math.floor(value)))
}

/**
 * 生成当前环境可发现的全量工具摘要，供调用方放入稳定 system 前缀。
 *
 * 这里只包含 name/description/runtime；inputSchema、guide 仍只能经 request_tool_schema
 * 懒加载。description 折叠为空白稳定的单行，避免第三方工具的换行破坏清单边界。
 */
export function buildToolManifestText(
  hostHasLocalCapabilities: boolean,
  options?: BuildTurnToolsOptions,
): string {
  const tools = availableToolSummaries(hostHasLocalCapabilities, options)
  const lines = tools.map((tool) => {
    const description = tool.description.replace(/\s+/g, ' ').trim()
    return `· ${tool.name} [${tool.runtime}] — ${description}`
  })

  return [
    '可用工具摘要（当前环境；仅用于发现，不代表参数 schema 已加载）：',
    ...(lines.length > 0 ? lines : ['（当前没有可发现的业务工具）']),
    '需要调用尚未加载的工具时，先用 request_tool_schema 的 toolName 传入上述精确名称，读取完整参数 schema；加载成功后该 schema 会在后续轮次继续保留。',
  ].join('\n')
}

const TOOL_MANIFEST_CURSOR_PREFIX = 'tool-manifest-v1'

function manifestCatalogFingerprint(query: string, tools: readonly ToolSummary[]): string {
  return fnv1a32(JSON.stringify({
    query,
    tools: tools.map((tool) => [tool.name, tool.description, tool.triggers ?? [], tool.runtime]),
  }))
}

function manifestCursor(fingerprint: string, offset: number): string {
  return `${TOOL_MANIFEST_CURSOR_PREFIX}:${fingerprint}:${offset}`
}

function parseManifestCursor(cursor: string): { fingerprint: string; offset: number } | undefined {
  const match = /^tool-manifest-v1:([0-9a-f]{8}):([0-9]+)$/.exec(cursor)
  if (!match) return undefined
  const offset = Number(match[2])
  if (!Number.isSafeInteger(offset)) return undefined
  return { fingerprint: match[1], offset }
}

function manifestError(
  code: ToolManifestError['code'],
  error: string,
  query: string,
  limit: number,
): ToolManifestError {
  return {
    kind: 'tool_manifest_error',
    code,
    error,
    restart: { query, limit },
  }
}

/**
 * 返回经过环境/权限过滤的有界工具目录页，不包含 inputSchema 或 guide。
 *
 * query 以空白分词，对 name/description/triggers/runtime 做大小写无关的 AND 匹配；结果固定按名称排序。
 * cursor 同时绑定 query 与完整匹配目录的指纹。翻页期间 registry 变化时返回 stale_cursor，
 * 让调用方从第一页重启，避免 offset 漂移导致工具被静默跳过。
 */
export function searchToolManifestPage(
  input: ToolManifestSearchInput,
  hostHasLocalCapabilities: boolean,
  options?: BuildTurnToolsOptions,
): ToolManifestResult {
  const query = input.query?.trim() ?? ''
  const limit = normalizedManifestLimit(input.limit)
  if (query.length > MAX_TOOL_MANIFEST_QUERY_LENGTH) {
    return manifestError(
      'query_too_long',
      `query 最多 ${MAX_TOOL_MANIFEST_QUERY_LENGTH} 个字符`,
      query.slice(0, MAX_TOOL_MANIFEST_QUERY_LENGTH),
      limit,
    )
  }

  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const matched = availableToolSummaries(hostHasLocalCapabilities, options).filter((tool) => {
    if (terms.length === 0) return true
    const searchable = [
      tool.name,
      tool.description,
      ...(tool.triggers ?? []),
      tool.runtime,
    ].join('\n').toLowerCase()
    return terms.every((term) => searchable.includes(term))
  })
  const fingerprint = manifestCatalogFingerprint(query, matched)

  let offset = 0
  if (input.cursor) {
    const parsed = parseManifestCursor(input.cursor)
    if (!parsed) {
      return manifestError('invalid_cursor', 'cursor 格式无效，请从第一页重新查询', query, limit)
    }
    if (parsed.fingerprint !== fingerprint) {
      return manifestError(
        'stale_cursor',
        '工具目录或 query 已变化，请从第一页重新查询',
        query,
        limit,
      )
    }
    if (parsed.offset >= matched.length && parsed.offset !== 0) {
      return manifestError('invalid_cursor', 'cursor 已超出结果范围，请从第一页重新查询', query, limit)
    }
    offset = parsed.offset
  }

  const items = matched.slice(offset, offset + limit)
  const nextOffset = offset + items.length
  const hasMore = nextOffset < matched.length
  return {
    kind: 'tool_manifest_page',
    query,
    items,
    total: matched.length,
    limit,
    hasMore,
    ...(hasMore ? { nextCursor: manifestCursor(fingerprint, nextOffset) } : {}),
  }
}
