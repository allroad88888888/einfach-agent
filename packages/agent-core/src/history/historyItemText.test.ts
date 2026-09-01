import type { ModelItem } from '@einfach-agent/ai'
import { describe, expect, it } from 'vitest'

import {
  AGENT_HISTORY_ITEM_JSON_MAX_BYTES,
  agentHistoryItemJson,
  agentHistoryItemPreview,
  agentHistoryItemRole,
  agentHistoryItemSearchText,
  boundedUtf8ByteCount,
  decodeAgentHistoryModelItem,
  readAgentHistoryText,
} from './historyItemText'

describe('history item text', () => {
  const items: ModelItem[] = [
    { role: 'user', content: [{ type: 'text', text: 'question' }] },
    {
      role: 'assistant', content: 'answer', reasoning_content: 'reason',
      tool_calls: [{ id: 'call', type: 'function', function: { name: 'lookup', arguments: '{"id":1}' } }],
    },
    { role: 'tool', tool_call_id: 'call', content: 'result' },
  ]

  it('extracts roles, searchable text, preview, and stable JSON', () => {
    expect(items.map(agentHistoryItemRole)).toEqual(['user', 'assistant', 'tool'])
    expect(agentHistoryItemSearchText(items[0])).toBe('question')
    expect(agentHistoryItemSearchText(items[1])).toContain('lookup')
    expect(agentHistoryItemPreview({ role: 'user', content: 'x'.repeat(2_001) })).toHaveLength(2_000)
    expect(decodeAgentHistoryModelItem(agentHistoryItemJson(items[2]))).toEqual(items[2])
  })

  it('chunks by Unicode code point without splitting surrogate pairs', () => {
    expect(readAgentHistoryText('a😀中z', 1, 2)).toEqual({
      text: '😀中', offset: 1, nextOffset: 3, totalChars: 4,
    })
    expect(readAgentHistoryText('a\uD83Db', 1, 1)).toEqual({
      text: '\uD83D', offset: 1, nextOffset: 2, totalChars: 3,
    })
    expect(agentHistoryItemPreview({ role: 'user', content: `${'x'.repeat(1_999)}\uD83Db` }))
      .toBe(`${'x'.repeat(1_999)}\uD83D`)
  })

  it('rejects ModelItem JSON before an oversized parse', () => {
    const oversized = `{"role":"user","content":"${'x'.repeat(AGENT_HISTORY_ITEM_JSON_MAX_BYTES)}"}`
    const count = boundedUtf8ByteCount(oversized, AGENT_HISTORY_ITEM_JSON_MAX_BYTES)
    expect(count).toMatchObject({ exceeded: true, bytes: AGENT_HISTORY_ITEM_JSON_MAX_BYTES + 1 })
    expect(count.codeUnitsRead).toBeLessThan(oversized.length)
    expect(() => decodeAgentHistoryModelItem(oversized)).toThrow(/exceeds/)
    expect(() => decodeAgentHistoryModelItem('{bad')).toThrow(/Invalid ModelItem JSON/)
  })

  it('counts UTF-8 bytes without allocating an encoded copy', () => {
    expect(boundedUtf8ByteCount('a¢中😀\uD83D', 100)).toEqual({
      bytes: 13, exceeded: false, codeUnitsRead: 6,
    })
  })
})
