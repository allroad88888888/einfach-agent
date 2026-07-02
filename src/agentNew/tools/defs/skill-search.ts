// tools/defs/skill-search.ts —— 按名称/描述/触发词搜索仓库 skills（TOOLS-SPEC §9/§10）。
// runtime 'internal'：纯只读查询，无副作用。绝不 import state/store/atom；只依赖 skills registry 的只读查询。
import type { Tool } from '../types'
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
    content: `# skill_search

按名称、描述或触发词模糊搜索仓库里已注册的 skills，用来发现「有没有相关的技能指南可读」。

## 何时用
- 拿到任务不确定该按什么套路做时，先搜一把相关 skill（如「图表」「提问」「可视化」）看有没有现成指南。
- 命中后再用 \`skill_read\` 读取该 skill 的完整正文。

## 参数
- \`query\`（string，必填）：搜索词，大小写不敏感，按 skill 的 名称/描述/触发词 子串匹配。空字符串会匹配全部。

## 返回
\`{ query, results }\`，其中 \`results\` 是命中 skill 的摘要数组（name/description/triggers），可能为空数组。

## 注意
- 只做只读搜索，不会读出正文；要正文请接着调 \`skill_read\`。`,
  },
  inputSchema,
  execute(args) {
    // §10 防御式取参：非法/缺失 query 收敛成空字符串，不崩。
    const query = String(asRecord(args).query ?? '')
    return { ok: true, data: { query, results: searchSkills(query) } }
  },
}
