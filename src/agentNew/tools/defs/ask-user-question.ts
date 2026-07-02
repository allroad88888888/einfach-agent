// tools/defs/ask-user-question.ts —— 暂停 run，向用户提出结构化问题收集缺失决策（TOOLS-SPEC §7/§9/§10）。
// runtime 'internal'。关键契约：合法 questions → 返回 { pause: args }，由 harness 置 waiting_user 并暂停 run。
// 绝不 import 任何 state/store/atom —— 暂停/回填全由 harness 循环侧处理，本工具只做参数校验。
import type { Tool } from '../types'

// inputSchema 照抄旧 registry 的 ask_user_question（TOOLS-SPEC §12 迁移，required: id + questions）。
const inputSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'text', 'type'],
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          type: { enum: ['text', 'single-choice', 'multi-choice', 'confirm'] },
          options: { type: 'array', items: { type: 'string' } },
          required: { type: 'boolean' },
        },
      },
    },
  },
  required: ['id', 'questions'],
}

// 防御式把未知 args 视为普通对象（非对象 → 空对象），避免直接取字段崩。
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export const askUserQuestionTool: Tool = {
  name: 'ask_user_question',
  runtime: 'internal',
  skill: {
    description: '暂停当前 run，向用户提出一个或多个结构化问题并收集缺失决策。',
    triggers: ['提问', '确认', '不明确', 'ask user'],
    content: `# ask_user_question

当任务缺少会改变最终方案的关键约束时，不要猜测——用本工具暂停当前 run，向用户提出结构化问题并等待作答。

## 何时用
- 目标范围 / 交互模式 / 技术边界 / 部署环境等关键约束缺失，且合理默认值不够安全时。
- 问题保持少而精：优先问会改变方案的约束；能安全用默认值的就别问，直接在回答里说明默认值。

## 参数
- \`id\`（string，必填）：本次提问的唯一标识。
- \`title\`（string，可选）：提问卡片标题。
- \`questions\`（array，必填，且非空）：问题列表，每项：
  - \`id\`（string，必填）：问题标识。
  - \`text\`（string，必填）：问题文案。
  - \`type\`（必填）：\`text\` | \`single-choice\` | \`multi-choice\` | \`confirm\`。
  - \`options\`（string[]，choice 类必给）：可选项。
  - \`required\`（boolean，可选）：是否必答。

## 行为（重要）
- 参数合法（\`questions\` 是非空数组）→ **暂停当前 run**，run 状态置 \`waiting_user\`，等用户在卡片里作答后再继续；本轮不会有普通的 tool 结果回填。
- 参数非法（缺 \`questions\` 或空数组）→ 返回错误、不暂停，循环照常继续。`,
  },
  inputSchema,
  execute(args) {
    // §7：合法 questions（非空数组）→ 返回 { pause: 原 args }，交给 harness 暂停 run 收答案。
    const questions = asRecord(args).questions
    if (Array.isArray(questions) && questions.length > 0) {
      return { pause: args }
    }
    // 非法参数 → ok:false（TK6，不 throw、不暂停）。
    return { ok: false, error: 'invalid ask_user_question: questions (non-empty array) required' }
  },
}
