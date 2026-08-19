import { describe, expect, it, vi } from 'vitest'
import { createHistory, createStore } from '@einfach/core'
import type { ModelItem } from '@einfach-agent/ai'

import { sessionsAtom } from '../../../state/rootStore'
import type { ModelSettings, SessionMeta } from '../../../state/core.type'
import { makeCoreCtx } from '../coreCtx'
import { assemblePlugins } from '../pluginApi'
import { compactionPlugin, type CompactionRequestDraft } from './compactionPlugin'
import { createSessionHistory } from '../../../state/sessionHistory'

function fakeMeta(settings: ModelSettings): SessionMeta {
  return { settings } as unknown as SessionMeta
}

function fakeContext(settings: ModelSettings) {
  const traceEvent = vi.fn()
  const root = createStore()
  root.setter(sessionsAtom, { s1: fakeMeta(settings) })
  return {
    traceEvent,
    ctx: makeCoreCtx({ history: createSessionHistory(createStore()),
      sessionId: 's1',
      runId: 'r1',
      signal: new AbortController().signal,
      store: createStore(),
      root,
      traceEvent,
    }),
  }
}

function toolGroup(callId: string, content: string): ModelItem[] {
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: callId, type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: callId, content },
  ]
}

function toolProtocolIsIntact(items: readonly ModelItem[]): boolean {
  const declared = new Set<string>()
  for (const item of items) {
    if (item.role === 'assistant') {
      for (const call of item.tool_calls ?? []) declared.add(call.id)
      continue
    }
    if (item.role === 'tool' && !declared.has(item.tool_call_id)) return false
  }
  return true
}

describe('compactionPlugin incremental projection extension', () => {
  it('compresses only an overflowing appended tail while retaining the previous projection byte-stable', async () => {
    const { ctx, traceEvent } = fakeContext({ vendor: 'deepseek', model: 'x', max_tokens: 100 })
    const hooks = assemblePlugins([compactionPlugin])
    const large = JSON.stringify({ data: 'x'.repeat(400_000) })
    const base: ModelItem[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'inspect these files' },
      ...toolGroup('first', large),
      { role: 'assistant', content: 'first result' },
    ]
    const first: CompactionRequestDraft = { messages: base, tools: [], llmTurn: 1 }

    await hooks.transformContext?.(ctx, first)
    expect(first.compaction?.compacted).toBe(true)
    const stablePrefix = first.messages

    const second: CompactionRequestDraft = {
      messages: [...base, ...toolGroup('second', large)],
      tools: [],
      llmTurn: 2,
    }
    await hooks.transformContext?.(ctx, second)

    stablePrefix.forEach((item, index) => expect(second.messages[index]).toBe(item))
    expect(second.compaction?.compacted).toBe(true)
    expect(second.compaction?.withinBudget).toBe(true)
    expect(toolProtocolIsIntact(second.messages)).toBe(true)
    expect(traceEvent).toHaveBeenCalledWith('llm.context_projection_extended', expect.objectContaining({
      llm_turn: 2,
      appended_items: 2,
    }))
    expect(traceEvent.mock.calls.filter(([name]) => name === 'llm.context_compacted')).toHaveLength(2)
    expect(traceEvent).not.toHaveBeenCalledWith('llm.context_projection_reused', expect.objectContaining({
      llm_turn: 2,
    }))
  })
})
