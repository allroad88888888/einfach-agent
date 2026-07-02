// tools/skill-search/skill-search.ts —— 按名称/描述/触发词搜索仓库 skills（TOOLS-SPEC §9/§10）。
// runtime 'internal'：纯只读查询，无副作用。绝不 import state/store/atom；只依赖 skills registry 的只读查询。
import type { Tool } from '../types'
import guide from './skill-search.md?raw' // skill 正文（同目录 .md）
import { searchSkills } from '../../skills/registry'

const inputSchema = {
  type: 'object',
  properties: {
    query: { type: 'string' },
  },
  required: ['query'],
}

// 防御式把未知 args 视为普通对象（非对象 → 空对象），避免直接取字段崩。
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export const skillSearchTool: Tool = {
  name: 'skill_search',
  runtime: 'internal',
  skill: {
    description: '按名称/描述/触发词搜索仓库 skills。',
    triggers: ['skill', '技能', '搜索 skill', 'skill search'],
    content: guide,
  },
  inputSchema,
  execute(args) {
    // §10 防御式取参：非法/缺失 query 收敛成空字符串，不崩。
    const query = String(asRecord(args).query ?? '')
    return { ok: true, data: { query, results: searchSkills(query) } }
  },
}
