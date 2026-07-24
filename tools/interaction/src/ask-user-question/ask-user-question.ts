// tools/ask-user-question/ask-user-question.ts —— 暂停 run，向用户提出结构化问题收集缺失决策（TOOLS-SPEC §7/§9/§10）。
// runtime 'internal'。关键契约：合法 questions → 返回 { pause: args }，由 harness 置 waiting_user 并暂停 run。
// 绝不 import 任何 state/store/atom —— 暂停/回填全由 harness 循环侧处理，本工具只做参数校验。
import type { Tool } from '@web-agent/core/tools/types'
import guide from './ask-user-question.md?raw' // skill 正文（同目录 .md）

// inputSchema —— 【刻意宽松】：本工具的唯一真相是 runtime/askUserQuestion.ts 的
// normalizeAskUserQuestionPayload 是该 payload 的真相来源：它逐条校验 id/text，非法项丢弃，
// type 不识别归一为 'text'。registry.run() 的 schema 硬校验一旦比归一化层更严，
// 模型只要把一个 enum 写歪（'multiple-choice'）或漏一个 question 级 id，
// 整个调用就会在 registry 层被打回 { ok:false }：走 appendMappedToolResult 而不进 waiting_user，
// 【提问卡片彻底不渲染】，归一化层则沦为不可达代码。
// 所以这里只硬性要求 `questions`（execute 还会再判「非空数组」），其余全部交给归一化层兜底；
// 取值范围等模型必须知道的信息，改用 description 承载（schema 会随 request_tool_schema 发给模型）。
const inputSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '本次提问的唯一标识（建议必给；缺失时不会报错）。' },
    title: { type: 'string', description: '提问卡片标题（可选）。' },
    context: {
      description: "问题归属（可选）。制定计划期间必须传 { surface: 'plan', phase: 'drafting' }；普通对话问题使用 { surface: 'conversation' }。执行中的计划会由宿主自动补全 plan/stage。",
    },
    questions: {
      type: 'array',
      description: '问题列表，必须是非空数组。',
      items: {
        type: 'object',
        // question 级字段【一律不做类型硬校验】，只用 description 告诉模型期望形状。
        // 理由同上：归一化层对每个字段都有兜底（id/text 非法 → 丢弃该问题项，type 不识别 → 'text'，
        // options 非 string 数组 → 丢弃该字段，required 非 boolean → 不写该字段），
        // 而 schema 层的类型拒绝会让整次提问在 registry 就失败、卡片不渲染。
        // 模型把 options 写成 [{label,value}] 对象数组是相当常见的笔误，不该因此毙掉整张卡片。
        properties: {
          id: { description: '问题标识（字符串）；缺失或为空串的问题项会被直接丢弃。' },
          text: { description: '问题文案（字符串）；缺失或为空串的问题项会被直接丢弃。' },
          type: {
            description: "问题类型（字符串），取值为 'text' | 'single-choice' | 'multi-choice' | 'confirm' 之一；其它取值会被归一化为 'text'。",
          },
          options: {
            description: 'choice 类问题的可选项，必须是 string 数组；形状不对时该字段会被丢弃。',
          },
          required: { description: '是否必答（boolean，可选）；非 boolean 时该字段会被忽略。' },
        },
      },
    },
  },
  required: ['questions'],
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
