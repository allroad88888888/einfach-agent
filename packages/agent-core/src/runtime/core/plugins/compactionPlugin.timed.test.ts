import { describe, expect, it, vi } from 'vitest'
import { createHistory, createStore } from '@einfach/core'
import type { ModelItem } from '@einfach-agent/ai'

import { sessionsAtom } from '../../../state/rootStore'
import type { ModelSettings, SessionMeta } from '../../../state/core.type'
import { makeCoreCtx } from '../coreCtx'
import { createSessionHistory } from '../../../state/sessionHistory'
import {
  applyCompaction,
  createCompactionProjectionCache,
  type CompactionRequestDraft,
} from './compactionPlugin'

vi.mock('../../contextDistillation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contextDistillation')>()
  return { ...actual, contextNeedsDistillation: () => false }
})

function contextFor(settings: ModelSettings) {
  const root = createStore()
  root.setter(sessionsAtom, { s1: { settings } as unknown as SessionMeta })
  return makeCoreCtx({
    sessionId: 's1',
    runId: 'r1',
    signal: new AbortController().signal,
    store: createStore(),
    root, history: createSessionHistory(createStore()),
    traceEvent: vi.fn(),
  })
}

function overflowingMessages(chars = 4_000): ModelItem[] {
  return [
    { role: 'system', content: '系统指令' },
    { role: 'user', content: '第一轮' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'old', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'old', content: JSON.stringify({ data: 'x'.repeat(chars) }) },
    { role: 'assistant', content: '第一轮答复' },
    { role: 'user', content: '第二轮' },
  ]
}

function timedItem(id: string): ModelItem {
  return { role: 'tool', tool_call_id: id, content: JSON.stringify({ data: id }) }
}

// 只覆盖插件自己那层：把 dispatchTimedItems 挂上 draft 的两侧语义。
// 到点桶【本身】的触发路径已不经插件——它在 modelTurnRequester 的 checkpoint 蒸馏前后，
// 由 modelTurnRequester.compactionTiming.test.ts 覆盖（含恢复 fence 失败不发请求）。
describe('compactionPlugin 压缩时机', () => {
  it('未发生压缩时不分派任何压缩时机工具', async () => {
    const dispatchTimedItems = vi.fn(async () => [])
    const messages: ModelItem[] = [{ role: 'system', content: '系统' }, { role: 'user', content: '你好' }]
    const draft: CompactionRequestDraft = { messages, tools: [], dispatchTimedItems }

    await applyCompaction(contextFor({ vendor: 'deepseek', model: 'x' }), draft)

    expect(dispatchTimedItems).not.toHaveBeenCalled()
    expect(draft.messages).toBe(messages)
    expect(draft.compaction?.compacted).toBe(false)
  })

  it('在真实投影变换的两侧分派，且后置结果留在动态尾巴之前', async () => {
    const pre = timedItem('timed-pre')
    const post = timedItem('timed-post')
    const tail: ModelItem = { role: 'system', content: '动态控制尾巴' }
    const order: string[] = []
    const draft: CompactionRequestDraft = {
      messages: [...overflowingMessages(), tail],
      tools: [],
      dynamicTailCount: 1,
      dispatchTimedItems: async (timing) => {
        order.push(timing)
        if (timing === 'preCompact') {
          expect(draft.messages).not.toContain(pre)
          return [pre]
        }
        expect(draft.compaction?.compacted).toBe(true)
        expect(draft.messages).toContain(pre)
        expect(draft.messages).not.toContain(post)
        return [post]
      },
    }

    await applyCompaction(
      contextFor({ vendor: 'deepseek', model: 'x', max_tokens: 63_500 }),
      draft,
    )

    expect(order).toEqual(['preCompact', 'postCompact'])
    expect(draft.compaction?.items).toBe(draft.messages)
    expect(draft.messages).toContain(pre)
    expect(draft.messages.indexOf(pre)).toBeLessThan(draft.messages.indexOf(post))
    expect(draft.messages.at(-2)).toBe(post)
    expect(draft.messages.at(-1)).toBe(tail)
  })

  it('投影复用只沿用已压缩结果，不再次分派压缩时机工具', async () => {
    const cache = createCompactionProjectionCache()
    const firstItems = overflowingMessages(400_000)
    const firstDispatch = vi.fn(async (_timing: 'preCompact' | 'postCompact') => [])
    const settings = { vendor: 'deepseek', model: 'x', max_tokens: 100 } as const
    const first: CompactionRequestDraft = { messages: firstItems, tools: [], dispatchTimedItems: firstDispatch }

    await applyCompaction(contextFor(settings), first, cache)

    const secondDispatch = vi.fn(async () => [])
    const second: CompactionRequestDraft = {
      messages: firstItems,
      tools: [],
      dispatchTimedItems: secondDispatch,
    }
    await applyCompaction(contextFor(settings), second, cache)

    expect(firstDispatch.mock.calls.map(([timing]) => timing)).toEqual(['preCompact', 'postCompact'])
    expect(secondDispatch).not.toHaveBeenCalled()
    expect(second.compaction?.compacted).toBe(true)
  })
})
