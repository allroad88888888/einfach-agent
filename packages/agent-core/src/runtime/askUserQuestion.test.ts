import { describe, it, expect } from 'vitest'
import {
  normalizeAskUserQuestionPayload,
  type AskUserQuestionItem,
} from './askUserQuestion'

describe('normalizeAskUserQuestionPayload', () => {
  it('合法 payload：保留 title 与各类型问题的全字段', () => {
    const result = normalizeAskUserQuestionPayload({
      title: '请补充信息',
      questions: [
        { id: 'q-text', text: '你的名字？', type: 'text', required: true },
        { id: 'q-confirm', text: '确认吗？', type: 'confirm' },
        {
          id: 'q-single',
          text: '选一个',
          type: 'single-choice',
          options: ['A', 'B'],
        },
        {
          id: 'q-multi',
          text: '选多个',
          type: 'multi-choice',
          options: ['X', 'Y', 'Z'],
          required: false,
        },
      ],
    })

    expect(result.title).toBe('请补充信息')
    expect(result.questions).toEqual<AskUserQuestionItem[]>([
      { id: 'q-text', text: '你的名字？', type: 'text', required: true },
      { id: 'q-confirm', text: '确认吗？', type: 'confirm' },
      { id: 'q-single', text: '选一个', type: 'single-choice', options: ['A', 'B'] },
      {
        id: 'q-multi',
        text: '选多个',
        type: 'multi-choice',
        options: ['X', 'Y', 'Z'],
        required: false,
      },
    ])
  })

  it('缺 id 或 text（或为空串）的条目被丢弃，不抛异常', () => {
    const result = normalizeAskUserQuestionPayload({
      questions: [
        { text: '没有 id', type: 'text' },
        { id: 'no-text', type: 'text' },
        { id: '', text: '空 id', type: 'text' },
        { id: 'empty-text', text: '   ', type: 'text' },
        { id: 42, text: '数字 id', type: 'text' },
        { id: 'ok', text: '合法', type: 'text' },
      ],
    })

    expect(result.questions).toEqual<AskUserQuestionItem[]>([
      { id: 'ok', text: '合法', type: 'text' },
    ])
  })

  it('未知/非法 type 归一为 text', () => {
    const result = normalizeAskUserQuestionPayload({
      questions: [
        { id: 'q1', text: '未知类型', type: 'dropdown' },
        { id: 'q2', text: '类型非字符串', type: 123 },
        { id: 'q3', text: '缺 type' },
      ],
    })

    expect(result.questions).toEqual<AskUserQuestionItem[]>([
      { id: 'q1', text: '未知类型', type: 'text' },
      { id: 'q2', text: '类型非字符串', type: 'text' },
      { id: 'q3', text: '缺 type', type: 'text' },
    ])
  })

  it('options 不是 string 数组、required 不是 boolean 时被忽略', () => {
    const result = normalizeAskUserQuestionPayload({
      questions: [
        {
          id: 'q1',
          text: 'options 非数组',
          type: 'single-choice',
          options: 'A,B',
          required: 'yes',
        },
        {
          id: 'q2',
          text: 'options 含非字符串',
          type: 'multi-choice',
          options: ['A', 2, null],
          required: 1,
        },
      ],
    })

    expect(result.questions).toEqual<AskUserQuestionItem[]>([
      { id: 'q1', text: 'options 非数组', type: 'single-choice' },
      { id: 'q2', text: 'options 含非字符串', type: 'multi-choice' },
    ])
  })

  it('title 为空串或非字符串时被省略', () => {
    expect(
      normalizeAskUserQuestionPayload({ title: '   ', questions: [] }).title,
    ).toBeUndefined()
    expect(
      normalizeAskUserQuestionPayload({ title: 123, questions: [] }).title,
    ).toBeUndefined()
  })

  it('只保留合法的 Plan 决策上下文，非法 phase 被忽略', () => {
    expect(
      normalizeAskUserQuestionPayload({
        context: { surface: 'plan', phase: 'drafting' },
        questions: [],
      }).context,
    ).toEqual({ surface: 'plan', phase: 'drafting' })
    expect(
      normalizeAskUserQuestionPayload({
        context: { surface: 'conversation', phase: 'unknown' },
        questions: [],
      }).context,
    ).toEqual({ surface: 'conversation' })
    expect(
      normalizeAskUserQuestionPayload({
        context: { surface: 'sidebar', phase: 'drafting' },
        questions: [],
      }).context,
    ).toBeUndefined()
  })

  it('payload 为 null/字符串/数组/缺 questions 时返回空 questions', () => {
    expect(normalizeAskUserQuestionPayload(null)).toEqual({ questions: [] })
    expect(normalizeAskUserQuestionPayload(undefined)).toEqual({ questions: [] })
    expect(normalizeAskUserQuestionPayload('hello')).toEqual({ questions: [] })
    expect(normalizeAskUserQuestionPayload(42)).toEqual({ questions: [] })
    expect(normalizeAskUserQuestionPayload([{ id: 'q', text: 't' }])).toEqual({
      questions: [],
    })
    expect(normalizeAskUserQuestionPayload({ title: '有标题' })).toEqual({
      title: '有标题',
      questions: [],
    })
    expect(
      normalizeAskUserQuestionPayload({ questions: 'not-an-array' }),
    ).toEqual({ questions: [] })
  })
})
