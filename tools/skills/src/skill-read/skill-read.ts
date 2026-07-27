// tools/skill-read/skill-read.ts —— 读取已选中的仓库 skill 完整正文，或其单个 L3 资源
// （TOOLS-SPEC §9/§10；L3 资源见 docs/skills-tree-blueprint.md 阶段 1）。
// runtime 'internal'：纯只读查询，无副作用。绝不 import state/store/atom；只依赖 skills registry 的只读查询。
import type { Tool } from '@web-agent/core/tools/types'
import guide from './skill-read.md?raw' // skill 正文（同目录 .md）
import { readSkill, readSkillResource } from '@web-agent/core/skills/registry'

const inputSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    resource: { type: 'string' },
  },
  required: ['name'],
}

// 防御式把未知 args 视为普通对象（非对象 → 空对象），避免直接取字段崩。
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export const skillReadTool: Tool = {
  name: 'skill_read',
  execution: { mode: 'parallel', effectKeys: ['skills:read'] },
  runtime: 'internal',
  skill: {
    description: '读取已选中的仓库 skill 的完整正文；带 resource 参数时改读该 skill 的单个 L3 资源。',
    triggers: ['skill', '技能', '读取 skill', 'skill read'],
    content: guide,
  },
  inputSchema,
  execute(args) {
    // §10 防御式取参：非法/缺失 name 收敛成空字符串，不崩；resource 非字符串时视为省略（读正文）。
    const record = asRecord(args)
    const name = String(record.name ?? '')
    const resource = typeof record.resource === 'string' ? record.resource : undefined

    if (resource !== undefined) {
      const result = readSkillResource(name, resource)
      // 未命中（skill 不存在或资源键不存在）→ error 原样透传，文案已含可用资源键列表引导自我修正。
      if (!result.ok) return { ok: false, error: result.error }
      return {
        ok: true,
        data: {
          name: result.name,
          resource: result.resourcePath,
          content: result.content,
          truncated: result.truncated,
        },
      }
    }

    const skill = readSkill(name)
    // 命中 → ok:true 带正文 + 可读资源目录；未命中 → ok:false 带明确 error（TK6，不 throw）。
    return skill
      ? { ok: true, data: { name, skill, resources: skill.resources } }
      : { ok: false, error: `skill not found: ${name}` }
  },
}
