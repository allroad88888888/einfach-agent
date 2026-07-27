// tools/skill-search/skill-search.ts —— 按名称/描述/触发词搜索仓库 skills（TOOLS-SPEC §9/§10）。
// runtime 'internal'：纯只读查询，无副作用。绝不 import state/store/atom；只依赖 skills registry 的只读查询。
import type { Tool } from '@web-agent/core/tools/types'
import guide from './skill-search.md?raw' // skill 正文（同目录 .md）
import { searchSkills } from '@web-agent/core/skills/registry'

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50

const inputSchema = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
  },
  additionalProperties: false,
}

// 防御式把未知 args 视为普通对象（非对象 → 空对象），避免直接取字段崩。
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export const skillSearchTool: Tool = {
  name: 'skill_search',
  execution: { mode: 'parallel', effectKeys: ['skills:read'] },
  runtime: 'internal',
  skill: {
    description: '按名称/描述/触发词搜索仓库 skills。',
    triggers: ['skill', '技能', '搜索 skill', 'skill search'],
    content: guide,
  },
  inputSchema,
  execute(args) {
    // query 省略或为空字符串都表示列出全部；未知字段已由 schema 拒绝。
    const input = asRecord(args)
    const query = typeof input.query === 'string' ? input.query.trim() : ''
    const limit = typeof input.limit === 'number' && Number.isSafeInteger(input.limit)
      ? Math.max(1, Math.min(MAX_LIMIT, input.limit))
      : DEFAULT_LIMIT
    const matches = searchSkills(query)
    return {
      ok: true,
      data: {
        query,
        results: matches.slice(0, limit),
        total: matches.length,
        limit,
        truncated: matches.length > limit,
      },
    }
  },
}
