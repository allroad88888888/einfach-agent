import { describe, expect, it } from 'vitest'
import type { ModelItem, UserMessageContent } from '@web-agent/ai'
import { sessionsAtom } from '../state/rootStore'
import { checkpointsAtom, itemsAtom } from '../state/sessionAtoms'
import type { ConversationItem, SessionMeta } from '../state/core.type'
import { commitCheckpoint, jumpToCheckpoint } from '../state/checkpointWriters'
import { compactContext } from './contextCompaction'
import { createCoreInstance } from './core/coreInstance'
import { llmRequestTracePreview } from './runLoopTelemetry'

const structuredContent: UserMessageContent = [
  { type: 'text', text: '看看这张图' },
  {
    type: 'image',
    source: {
      kind: 'provider-file',
      provider: 'kimi',
      scope: 'private-scope',
      reference: 'ms://private-reference',
    },
    name: 'chart.png',
    mimeType: 'image/png',
    byteSize: 42,
    width: 4,
    height: 3,
  },
]

function conversationItem(id: string, content: UserMessageContent): ConversationItem {
  return { id, createdAt: 1, item: { role: 'user', content } }
}

describe('structured user content retention', () => {
  it('redacts provider references from request traces', () => {
    const trace = llmRequestTracePreview({
      model: 'kimi-k2.6',
      messages: [{ role: 'user', content: structuredContent }],
    })

    expect(trace).toContain('看看这张图')
    expect(trace).toContain('imageCount')
    expect(trace).not.toContain('private-reference')
    expect(trace).not.toContain('private-scope')
    expect(trace).not.toContain('provider-file')
  })

  it('keeps the latest structured user message exact during compaction', () => {
    const messages: ModelItem[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'old '.repeat(1_000) },
      { role: 'assistant', content: 'answer '.repeat(1_000) },
      { role: 'user', content: structuredContent },
    ]

    const result = compactContext(messages, { maxTokens: 1, keepRecentTurns: 0 })
    const latest = result.items.at(-1)

    expect(result.compacted).toBe(true)
    expect(latest).toEqual({ role: 'user', content: structuredContent })
  })

  it('round-trips structured content through checkpoint commit and rewind', () => {
    const core = createCoreInstance()
    const session: SessionMeta = {
      id: 'structured-session',
      title: 'structured',
      settings: { vendor: 'kimi', model: 'kimi-k2.6', thinking: true },
      createdAt: 1,
      updatedAt: 1,
    }
    core.rootStore.setter(sessionsAtom, { [session.id]: session })
    const store = core.getSessionStore(session.id).store
    const first = [conversationItem('image-turn', structuredContent)]
    store.setter(itemsAtom, first)
    commitCheckpoint(session.id, '图片轮次', core)
    store.setter(itemsAtom, [...first, conversationItem('later-turn', 'later')])
    commitCheckpoint(session.id, '后续轮次', core)

    jumpToCheckpoint(session.id, 0, core)

    expect(store.getter(itemsAtom)).toEqual(first)
    expect(store.getter(checkpointsAtom)[0].items[0].item).toEqual({
      role: 'user',
      content: structuredContent,
    })
  })
})
