import { describe, expect, it } from 'vitest'
import { buildConversationContext } from './conversation-context'
import type { ChatMessage } from './types'

const msg = (over: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role' | 'content'>): ChatMessage => ({
  createdAt: 1,
  ...over,
})

describe('M1.3 buildConversationContext — run boundary + eligible filter', () => {
  it('only includes messages before historyEndIndex (current-run messages excluded)', () => {
    const messages: ChatMessage[] = [
      msg({ id: 'welcome', role: 'assistant', content: 'Web Agent 已就绪。' }),
      msg({ id: 'u1', role: 'user', content: '第一个问题' }),
      msg({ id: 'a1', role: 'assistant', content: '第一个回答' }),
      // ↓ everything from here is the current run, must NOT be history
      msg({ id: 'u2', role: 'user', content: '当前 run 的提问' }),
      msg({ id: 'a-ask', role: 'assistant', content: '我需要先确认（1 个问题）。' }),
      msg({ id: 'u-supplied', role: 'user', content: '已补充：\n- x: y' }),
      msg({ id: 'a2', role: 'assistant', content: '最终回答', streaming: true }),
    ]
    // boundary captured before appending the current-run user (index 3)
    const ctx = buildConversationContext(messages, { summary: '', summarizedUpTo: 0 }, 3)

    expect(ctx.recentMessages).toEqual([
      { role: 'user', content: '第一个问题' },
      { role: 'assistant', content: '第一个回答' },
    ])
    // none of the current-run messages leak in
    const serialized = JSON.stringify(ctx.recentMessages)
    expect(serialized).not.toContain('当前 run 的提问')
    expect(serialized).not.toContain('我需要先确认')
    expect(serialized).not.toContain('已补充')
    expect(serialized).not.toContain('最终回答')
  })

  it('excludes the initial welcome (first assistant), system, streaming and empty messages', () => {
    const messages: ChatMessage[] = [
      msg({ id: 'welcome', role: 'assistant', content: 'Web Agent 已就绪。' }), // welcome → excluded
      msg({ id: 'sys', role: 'system', content: '系统提示' }), // system → excluded
      msg({ id: 'u1', role: 'user', content: '有效问题' }), // kept
      msg({ id: 'empty', role: 'assistant', content: '   ' }), // empty/whitespace → excluded
      msg({ id: 'stream', role: 'assistant', content: '半条', streaming: true }), // streaming → excluded
      msg({ id: 'a1', role: 'assistant', content: '有效回答' }), // kept
    ]
    const ctx = buildConversationContext(messages, { summary: '', summarizedUpTo: 0 }, messages.length)

    expect(ctx.recentMessages).toEqual([
      { role: 'user', content: '有效问题' },
      { role: 'assistant', content: '有效回答' },
    ])
  })

  it('passes through the summary and applies summarizedUpTo as the slice start', () => {
    const messages: ChatMessage[] = [
      msg({ id: 'welcome', role: 'assistant', content: 'Web Agent 已就绪。' }),
      msg({ id: 'u1', role: 'user', content: '旧问题（已压缩）' }),
      msg({ id: 'a1', role: 'assistant', content: '旧回答（已压缩）' }),
      msg({ id: 'u2', role: 'user', content: '近问题' }),
      msg({ id: 'a2', role: 'assistant', content: '近回答' }),
    ]
    const ctx = buildConversationContext(messages, { summary: '历史摘要', summarizedUpTo: 3 }, messages.length)

    expect(ctx.summary).toBe('历史摘要')
    expect(ctx.recentMessages).toEqual([
      { role: 'user', content: '近问题' },
      { role: 'assistant', content: '近回答' },
    ])
  })

  it('M1: with summarizedUpTo=0 and empty summary, recentMessages is the full eligible history', () => {
    const messages: ChatMessage[] = [
      msg({ id: 'welcome', role: 'assistant', content: 'Web Agent 已就绪。' }),
      msg({ id: 'u1', role: 'user', content: 'q1' }),
      msg({ id: 'a1', role: 'assistant', content: 'a1' }),
      msg({ id: 'u2', role: 'user', content: 'q2' }),
      msg({ id: 'a2', role: 'assistant', content: 'a2' }),
    ]
    const ctx = buildConversationContext(messages, { summary: '', summarizedUpTo: 0 }, messages.length)

    expect(ctx.summary).toBe('')
    expect(ctx.recentMessages).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ])
  })

  it('returns an empty recentMessages array when there is no eligible history (fresh session)', () => {
    const messages: ChatMessage[] = [
      msg({ id: 'welcome', role: 'assistant', content: 'Web Agent 已就绪。' }),
    ]
    const ctx = buildConversationContext(messages, { summary: '', summarizedUpTo: 0 }, 1)

    expect(ctx.summary).toBe('')
    expect(ctx.recentMessages).toEqual([])
  })
})

describe('MF1 welcome排除只针对 index===0 的 assistant', () => {
  it('does NOT drop the first user of a createSession session (initial messages empty, first message is user)', () => {
    // createSession seeds an EMPTY messages array — the first message is the
    // user's first input, NOT a welcome assistant. It must survive once it is
    // prior-run history.
    const messages: ChatMessage[] = [
      msg({ id: 'u1', role: 'user', content: '新会话第一句' }), // index 0, role user
      msg({ id: 'a1', role: 'assistant', content: '第一句回答' }),
      // current run begins here (boundary = 2)
      msg({ id: 'u2', role: 'user', content: '新会话第二句' }),
    ]
    const ctx = buildConversationContext(messages, { summary: '', summarizedUpTo: 0 }, 2)

    expect(ctx.recentMessages).toEqual([
      { role: 'user', content: '新会话第一句' },
      { role: 'assistant', content: '第一句回答' },
    ])
  })

  it('still drops an index===0 assistant welcome', () => {
    const messages: ChatMessage[] = [
      msg({ id: 'welcome', role: 'assistant', content: 'Web Agent 已就绪。' }),
      msg({ id: 'u1', role: 'user', content: 'q1' }),
      msg({ id: 'a1', role: 'assistant', content: 'a1' }),
    ]
    const ctx = buildConversationContext(messages, { summary: '', summarizedUpTo: 0 }, 3)

    expect(ctx.recentMessages).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ])
  })
})

describe('MF3 missing boundary conservatively disables memory', () => {
  it('returns empty recentMessages when historyEndIndex is undefined (never falls back to messages.length)', () => {
    const messages: ChatMessage[] = [
      msg({ id: 'u1', role: 'user', content: 'q1' }),
      msg({ id: 'a1', role: 'assistant', content: 'a1' }),
      msg({ id: 'u-supplied', role: 'user', content: '已补充：\n- x: y' }),
    ]
    const ctx = buildConversationContext(messages, { summary: '历史摘要', summarizedUpTo: 0 }, undefined)

    expect(ctx.recentMessages).toEqual([])
    expect(ctx.summary).toBe('')
  })
})

describe('MF4 completed-turn pairing — incomplete-run leftovers excluded', () => {
  it('drops a lone leftover user from a stopped run (no completed assistant)', () => {
    const messages: ChatMessage[] = [
      msg({ id: 'welcome', role: 'assistant', content: 'Web Agent 已就绪。' }),
      msg({ id: 'u1', role: 'user', content: '完成轮提问' }),
      msg({ id: 'a1', role: 'assistant', content: '完成轮回答' }),
      msg({ id: 'u-stopped', role: 'user', content: '被 stop 的孤立提问' }), // stopped run leftover
      // next run begins here (boundary = 4)
    ]
    const ctx = buildConversationContext(messages, { summary: '', summarizedUpTo: 0 }, 4)

    expect(ctx.recentMessages).toEqual([
      { role: 'user', content: '完成轮提问' },
      { role: 'assistant', content: '完成轮回答' },
    ])
    expect(JSON.stringify(ctx.recentMessages)).not.toContain('被 stop 的孤立提问')
  })

  it('drops a waiting_user AskUser placeholder pair (incomplete run)', () => {
    const messages: ChatMessage[] = [
      msg({ id: 'welcome', role: 'assistant', content: 'Web Agent 已就绪。' }),
      msg({ id: 'u1', role: 'user', content: '完成轮提问' }),
      msg({ id: 'a1', role: 'assistant', content: '完成轮回答' }),
      msg({ id: 'u2', role: 'user', content: '触发提问的输入' }),
      msg({ id: 'a-ask', role: 'assistant', content: '我需要先确认：需要确认（2 个问题）。', scaffold: 'ask-placeholder' }), // placeholder
      // user abandoned and started a fresh run (boundary = 5)
    ]
    const ctx = buildConversationContext(messages, { summary: '', summarizedUpTo: 0 }, 5)

    expect(ctx.recentMessages).toEqual([
      { role: 'user', content: '完成轮提问' },
      { role: 'assistant', content: '完成轮回答' },
    ])
    const serialized = JSON.stringify(ctx.recentMessages)
    expect(serialized).not.toContain('我需要先确认')
    expect(serialized).not.toContain('触发提问的输入')
  })

  it('keeps the real answer of a COMPLETED AskUser turn while dropping the placeholder + 已补充 scaffolding', () => {
    const messages: ChatMessage[] = [
      msg({ id: 'welcome', role: 'assistant', content: 'Web Agent 已就绪。' }),
      msg({ id: 'u1', role: 'user', content: '原始提问' }),
      msg({ id: 'a-ask', role: 'assistant', content: '我需要先确认：需要确认（2 个问题）。', scaffold: 'ask-placeholder' }), // placeholder
      msg({ id: 'u-supplied', role: 'user', content: '已补充：\n- scope: 直接给方案', scaffold: 'answer-echo' }), // 已补充 echo
      msg({ id: 'a-final', role: 'assistant', content: '这是最终回答' }), // real completed answer
      // next run boundary = 5
    ]
    const ctx = buildConversationContext(messages, { summary: '', summarizedUpTo: 0 }, 5)

    expect(ctx.recentMessages).toEqual([
      { role: 'user', content: '原始提问' },
      { role: 'assistant', content: '这是最终回答' },
    ])
    const serialized = JSON.stringify(ctx.recentMessages)
    expect(serialized).not.toContain('我需要先确认')
    expect(serialized).not.toContain('已补充')
  })

  it('drops an orphan assistant with no preceding pending user', () => {
    const messages: ChatMessage[] = [
      msg({ id: 'welcome', role: 'assistant', content: 'Web Agent 已就绪。' }),
      msg({ id: 'a-orphan', role: 'assistant', content: '孤立 assistant' }),
      msg({ id: 'u1', role: 'user', content: 'q1' }),
      msg({ id: 'a1', role: 'assistant', content: 'a1' }),
    ]
    const ctx = buildConversationContext(messages, { summary: '', summarizedUpTo: 0 }, 4)

    expect(ctx.recentMessages).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ])
  })
})

describe('MF7 scaffolding is recognised by the structural marker, not by content prefix', () => {
  it('does NOT drop a real user message that merely starts with "已补充：" (no scaffold marker)', () => {
    const messages: ChatMessage[] = [
      msg({ id: 'welcome', role: 'assistant', content: 'Web Agent 已就绪。' }),
      // A genuine user message that happens to begin with the echo prefix — it
      // carries NO scaffold marker, so it must survive as real history.
      msg({ id: 'u1', role: 'user', content: '已补充：我之前漏说的预算是 5 万' }),
      msg({ id: 'a1', role: 'assistant', content: '收到，预算 5 万。' }),
    ]
    const ctx = buildConversationContext(messages, { summary: '', summarizedUpTo: 0 }, 3)

    expect(ctx.recentMessages).toEqual([
      { role: 'user', content: '已补充：我之前漏说的预算是 5 万' },
      { role: 'assistant', content: '收到，预算 5 万。' },
    ])
  })

  it('does NOT drop a real assistant message that merely starts with "我需要先确认" (no scaffold marker)', () => {
    const messages: ChatMessage[] = [
      msg({ id: 'welcome', role: 'assistant', content: 'Web Agent 已就绪。' }),
      msg({ id: 'u1', role: 'user', content: '帮我确认方案' }),
      // A genuine assistant answer that happens to begin with the placeholder
      // prefix — NO scaffold marker, so it is real completed-turn content.
      msg({ id: 'a1', role: 'assistant', content: '我需要先确认几个关键点，然后已经给出完整方案如下……' }),
    ]
    const ctx = buildConversationContext(messages, { summary: '', summarizedUpTo: 0 }, 3)

    expect(ctx.recentMessages).toEqual([
      { role: 'user', content: '帮我确认方案' },
      { role: 'assistant', content: '我需要先确认几个关键点，然后已经给出完整方案如下……' },
    ])
  })

  it('DROPS messages carrying a scaffold marker regardless of content', () => {
    const messages: ChatMessage[] = [
      msg({ id: 'welcome', role: 'assistant', content: 'Web Agent 已就绪。' }),
      msg({ id: 'u1', role: 'user', content: '原始提问' }),
      // Marked scaffolding with arbitrary (non-prefixed) content — still excluded.
      msg({ id: 'a-ask', role: 'assistant', content: '占位文案任意', scaffold: 'ask-placeholder' }),
      msg({ id: 'u-echo', role: 'user', content: '回显文案任意', scaffold: 'answer-echo' }),
      msg({ id: 'a-final', role: 'assistant', content: '最终真实回答' }),
    ]
    const ctx = buildConversationContext(messages, { summary: '', summarizedUpTo: 0 }, 5)

    expect(ctx.recentMessages).toEqual([
      { role: 'user', content: '原始提问' },
      { role: 'assistant', content: '最终真实回答' },
    ])
  })

  it('keeps a complete [user, assistant] turn whose content uses the real prefixes verbatim', () => {
    const messages: ChatMessage[] = [
      msg({ id: 'welcome', role: 'assistant', content: 'Web Agent 已就绪。' }),
      msg({ id: 'u1', role: 'user', content: '已补充：上轮补充内容' }), // real, unmarked
      msg({ id: 'a1', role: 'assistant', content: '我需要先确认……（这是真实回答开头）' }), // real, unmarked
      // next run boundary = 3
    ]
    const ctx = buildConversationContext(messages, { summary: '', summarizedUpTo: 0 }, 3)

    expect(ctx.recentMessages).toEqual([
      { role: 'user', content: '已补充：上轮补充内容' },
      { role: 'assistant', content: '我需要先确认……（这是真实回答开头）' },
    ])
  })
})
