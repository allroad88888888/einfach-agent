// P8-a：把 `unknown` 的 ask_user_question payload 防御式规整成打字类型。
// ---------------------------------------------------------------------------
// RunState.pendingQuestion 存的是模型 tool_call 的原样 args（unknown），可能畸形。
// 卡片渲染前必须先经此 normalizer 收敛成 `{ id?, title?, questions: AskUserQuestionItem[] }`：
//   · 非法整体 → 空 questions；非法单条 → 丢弃该条；全程绝不抛（见 §5 R1）。
// AskUserAnswerValue 复用 state 侧的定义（agentNew 内单一来源），此处仅再导出便于消费。

import type { AskUserAnswerValue } from '../state/transientAtoms'

export type { AskUserAnswerValue }

// AskUserQuestion 支持的四种问题类型。
export type AskUserQuestionType = 'text' | 'confirm' | 'single-choice' | 'multi-choice'

// 单个问题项（规整后的稳定形状）。
export interface AskUserQuestionItem {
  id: string
  text: string
  type: AskUserQuestionType
  required?: boolean
  options?: string[]
}

// 规整后的整体载荷。
export interface AskUserQuestionPayload {
  /** Optional caller-provided correlation id retained for backwards compatibility. */
  id?: string
  title?: string
  context?: AskUserQuestionContext
  questions: AskUserQuestionItem[]
}

export interface AskUserQuestionContext {
  surface: 'conversation' | 'plan'
  phase?: 'drafting' | 'approval' | 'executing'
}

const QUESTION_TYPES: readonly AskUserQuestionType[] = [
  'text',
  'confirm',
  'single-choice',
  'multi-choice',
]

// 「纯对象」判定：排除 null 与数组。
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  return value as Record<string, unknown>
}

// 非空字符串判定（trim 后仍有内容）。
function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

// type 落在四种合法值内则原样，否则归一为 'text'。
function normalizeType(value: unknown): AskUserQuestionType {
  return typeof value === 'string' && (QUESTION_TYPES as readonly string[]).includes(value)
    ? (value as AskUserQuestionType)
    : 'text'
}

// options 仅当是「string 数组」（每一项都是 string）时保留，否则丢弃字段。
function normalizeOptions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  if (!value.every((entry): entry is string => typeof entry === 'string')) return undefined
  return value
}

function normalizeContext(value: unknown): AskUserQuestionContext | undefined {
  const context = asRecord(value)
  if (!context || (context.surface !== 'conversation' && context.surface !== 'plan')) return undefined

  const result: AskUserQuestionContext = { surface: context.surface }
  if (
    context.phase === 'drafting'
    || context.phase === 'approval'
    || context.phase === 'executing'
  ) {
    result.phase = context.phase
  }
  return result
}

// 逐条校验：无非空 string id/text → 丢弃（返回 undefined）。
function normalizeQuestion(value: unknown): AskUserQuestionItem | undefined {
  const item = asRecord(value)
  if (!item) return undefined
  if (!nonEmptyString(item.id) || !nonEmptyString(item.text)) return undefined

  const question: AskUserQuestionItem = {
    id: item.id,
    text: item.text,
    type: normalizeType(item.type),
  }

  const options = normalizeOptions(item.options)
  if (options) question.options = options

  if (typeof item.required === 'boolean') question.required = item.required

  return question
}

/**
 * 把 unknown 的 ask_user_question payload 防御式规整成打字类型。
 * - payload 非对象/为 null/数组 → `{ questions: [] }`。
 * - id/title 仅当非空字符串时保留。
 * - questions 非数组 → `[]`；逐条校验，非法项丢弃；type 不识别归 'text'。
 * - 全程绝不抛异常。
 */
export function normalizeAskUserQuestionPayload(payload: unknown): AskUserQuestionPayload {
  const value = asRecord(payload)
  if (!value) return { questions: [] }

  const result: AskUserQuestionPayload = { questions: [] }

  if (nonEmptyString(value.id)) result.id = value.id
  if (nonEmptyString(value.title)) result.title = value.title
  const context = normalizeContext(value.context)
  if (context) result.context = context

  if (Array.isArray(value.questions)) {
    for (const raw of value.questions) {
      const question = normalizeQuestion(raw)
      if (question) result.questions.push(question)
    }
  }

  return result
}
