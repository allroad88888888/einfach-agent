// tools/ask-user-question/ask-user-question.ts —— 暂停 run，向用户提出结构化问题收集缺失决策（TOOLS-SPEC §7/§9/§10）。
// runtime 'internal'。关键契约：合法 questions → 返回 { pause: args }，由 harness 置 waiting_user 并暂停 run。
// 绝不 import 任何 state/store/atom —— 暂停/回填全由 harness 循环侧处理，本工具只做参数校验。
import type { Tool } from '../types'
import guide from './ask-user-question.md?raw' // skill 正文（同目录 .md）

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
    content: guide,
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
