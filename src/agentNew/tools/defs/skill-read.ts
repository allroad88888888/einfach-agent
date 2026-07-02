// tools/defs/skill-read.ts —— 读取已选中的仓库 skill 完整正文（TOOLS-SPEC §9/§10）。
// runtime 'internal'：纯只读查询，无副作用。绝不 import state/store/atom；只依赖 skills registry 的只读查询。
import type { Tool } from '../types'
import { readSkill } from '../../skills/registry'

const inputSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
  },
  required: ['name'],
}

// 防御式把未知 args 视为普通对象（非对象 → 空对象），避免直接取字段崩。
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export const skillReadTool: Tool = {
  name: 'skill_read',
  runtime: 'internal',
  skill: {
    description: '读取已选中的仓库 skill 的完整正文。',
    triggers: ['skill', '技能', '读取 skill', 'skill read'],
    content: `# skill_read

按精确名称读取某个 skill 的完整 markdown 正文，用来在动手前吸收该技能的做法与注意事项。

## 何时用
- 已经用 \`skill_search\` 找到相关 skill、需要看它的完整指南时。
- 名称必须精确匹配（如 \`web-chat-agent\`、\`ask-user-question\`），不做模糊匹配。

## 参数
- \`name\`（string，必填）：skill 的精确名称。

## 返回
- 命中：\`{ name, skill }\`，其中 \`skill\` 含 name/description/triggers/content（content 即完整正文）。
- 未命中：\`{ error: "skill not found: <name>" }\`，不打断循环，可改用 \`skill_search\` 重新发现名称。`,
  },
  inputSchema,
  execute(args) {
    // §10 防御式取参：非法/缺失 name 收敛成空字符串，不崩。
    const name = String(asRecord(args).name ?? '')
    const skill = readSkill(name)
    // 命中 → ok:true 带正文；未命中 → ok:false 带明确 error（TK6，不 throw）。
    return skill ? { ok: true, data: { name, skill } } : { ok: false, error: `skill not found: ${name}` }
  },
}
