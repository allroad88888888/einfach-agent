import { describe, expect, it, vi } from 'vitest'
import { createHistory, createStore } from '@einfach/core'
import type { ModelItem } from '@einfach-agent/ai'

import { sessionsAtom } from '../../../state/rootStore'
import { itemsAtom, runAtom } from '../../../state/sessionAtoms'
import type { ModelSettings, SessionMeta } from '../../../state/core.type'
import type { Tool } from '../../../tools/types'
import { runSession } from '../../runToolLoop'
import { makeCoreCtx } from '../coreCtx'
import { createCoreInstance } from '../coreInstance'
import { createSessionHistory } from '../../../state/sessionHistory'
import {
  applyCompaction,
  compactionPlugin,
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

function timedTool(name: string, callTiming: 'preCompact' | 'postCompact', execute: Tool['execute']): Tool {
  return {
    name,
    runtime: 'internal',
    skill: { description: `${name} 测试工具`, content: name },
    inputSchema: { type: 'object', additionalProperties: false },
    callTiming,
    execute,
  }
}

function textResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

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

  it('经 Core 的受限分派入口记账，并把两侧结果带入同一次模型请求', async () => {
    const id = 'timed-compaction-core'
    const order: string[] = []
    const requests: ModelItem[][] = []
    const core = createCoreInstance({
      plugins: [compactionPlugin],
      registerTools(registry) {
        registry.register(timedTool('before_compact', 'preCompact', () => {
          order.push('preCompact')
          return { ok: true, data: 'before' }
        }))
        registry.register(timedTool('after_compact', 'postCompact', () => {
          order.push('postCompact')
          return { ok: true, data: 'after' }
        }))
      },
    })
    core.rootStore.setter(sessionsAtom, {
      [id]: {
        id,
        title: 'timed compaction',
        settings: { vendor: 'deepseek', model: 'x', max_tokens: 63_500 },
        createdAt: 0,
        updatedAt: 0,
      },
    })
    core.getSessionStore(id).store.setter(itemsAtom, overflowingMessages().map((item, index) => ({
      id: `history-${index}`,
      createdAt: index,
      item,
    })))

    await runSession(id, '第三轮', {
      signal: new AbortController().signal,
      apiKey: 'k',
      core,
      fetchImpl: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)).messages)
        return textResponse('完成')
      },
    })

    expect(order).toEqual(['preCompact', 'postCompact'])
    const timed = core.getSessionStore(id).store.getter(itemsAtom)
      .flatMap(({ item }) => item.role === 'tool' ? [item] : [])
    const pre = timed.find((item) => item.tool_call_id.includes(':before_compact'))
    const post = timed.find((item) => item.tool_call_id.includes(':after_compact'))
    expect(pre?.tool_call_id).toMatch(/^timed:preCompact:.+:before_compact$/)
    expect(post?.tool_call_id).toMatch(/^timed:postCompact:.+:after_compact$/)
    expect(requests).toHaveLength(1)
    const requestTimedIds = requests[0]
      .flatMap((item) => item.role === 'tool' ? [item.tool_call_id] : [])
    expect(requestTimedIds).toContain(pre?.tool_call_id)
    expect(requestTimedIds).toContain(post?.tool_call_id)
    expect(requestTimedIds.indexOf(pre!.tool_call_id)).toBeLessThan(requestTimedIds.indexOf(post!.tool_call_id))
  })

  it('压缩前时机的恢复 fence 失败时不发模型请求', async () => {
    const id = 'timed-compaction-fence-failure'
    const execute = vi.fn(() => ({ ok: true as const }))
    const fetchImpl = vi.fn(async () => textResponse('不应请求'))
    const core = createCoreInstance({
      plugins: [compactionPlugin],
      registerTools(registry) {
        registry.register(timedTool('before_compact', 'preCompact', execute))
      },
    })
    core.rootStore.setter(sessionsAtom, {
      [id]: {
        id,
        title: 'timed compaction fence failure',
        settings: { vendor: 'deepseek', model: 'x', max_tokens: 63_500 },
        createdAt: 0,
        updatedAt: 0,
      },
    })
    core.getSessionStore(id).store.setter(itemsAtom, overflowingMessages().map((item, index) => ({
      id: `history-${index}`,
      createdAt: index,
      item,
    })))
    vi.spyOn(core.persistence, 'persistRecovery').mockImplementation(async (sessionId, reason) => (
      reason === 'tool_call_execution_started'
        ? { status: 'tombstoned', sessionId }
        : { status: 'saved', sessionId, generation: 1, attempts: 1 }
    ))

    await runSession(id, '第三轮', {
      signal: new AbortController().signal,
      apiKey: 'k',
      core,
      fetchImpl,
    })

    expect(execute).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(core.getSessionStore(id).store.getter(runAtom)?.status).toBe('interrupted')
  })
})
