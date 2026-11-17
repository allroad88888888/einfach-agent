import type { Tool, WebSearchInput } from '@einfach-agent/core/tools'
import guide from './deepseek-search.md?raw'

const inputSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1, description: '1–128 个 Unicode 字符的搜索词，支持 site:、lang:、after:、before: 等语法。' },
    count: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
    ori_question: {
      oneOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
      description: '触发搜索的用户原始问题，1–128 个 Unicode 字符，可省略。',
    },
    localization: { type: 'string', description: '用于优先返回本地化结果的 IP 地址，可省略。' },
    need_content: { type: 'boolean', default: false, description: '是否返回网页正文。' },
  },
  required: ['query'],
  additionalProperties: false,
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && [...value].length <= 128
}

function parseInput(args: unknown): WebSearchInput | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  const value = args as Record<string, unknown>
  if (Object.keys(value).some((key) => !Object.hasOwn(inputSchema.properties, key))) return undefined
  if (!validText(value.query)) return undefined
  if (value.count !== undefined
    && (!Number.isInteger(value.count) || Number(value.count) < 1 || Number(value.count) > 50)) return undefined
  if (value.ori_question != null && !validText(value.ori_question)) return undefined
  if (value.localization !== undefined && typeof value.localization !== 'string') return undefined
  if (value.need_content !== undefined && typeof value.need_content !== 'boolean') return undefined
  return {
    query: value.query,
    count: (value.count as number | undefined) ?? 10,
    need_content: (value.need_content as boolean | undefined) ?? false,
    ...(value.ori_question == null ? {} : { ori_question: value.ori_question as string }),
    ...(value.localization === undefined ? {} : { localization: value.localization as string }),
  }
}

export const deepseekSearchTool: Tool = {
  name: 'deepseek_search',
  runtime: 'internal',
  replayUnsafe: true,
  execution: { mode: 'parallel' },
  skill: {
    description: '使用 DeepSeek 官方搜索引擎检索实时网页，返回标题、链接、摘要及可选正文；复用 DeepSeek 模型 API Key。',
    triggers: ['搜索', '联网', '最新消息', '网页搜索', 'web search', 'deepseek search'],
    content: guide,
  },
  inputSchema,
  async execute(args, ctx) {
    const input = parseInput(args)
    if (!input) return {
      ok: false, code: 'DEEPSEEK_SEARCH_INVALID_INPUT', retryable: false,
      error: '搜索参数无效：query/ori_question 应为 1–128 个字符的非空文本，count 应为 1–50 的整数。',
    }
    if (!ctx.webSearch) return {
      ok: false, code: 'DEEPSEEK_SEARCH_UNAVAILABLE', retryable: false,
      error: '当前宿主未配置 DeepSeek 搜索能力。',
    }
    if (ctx.signal.aborted) return {
      ok: false, code: 'DEEPSEEK_SEARCH_ABORTED', retryable: false, error: '搜索已取消。',
    }
    ctx.progress(`搜索：${input.query}`)
    try {
      return await ctx.webSearch(input)
    } catch {
      return {
        ok: false, code: 'DEEPSEEK_SEARCH_FAILED', retryable: !ctx.signal.aborted,
        error: ctx.signal.aborted ? '搜索已取消。' : '搜索未完成，请重试。',
      }
    }
  },
}
