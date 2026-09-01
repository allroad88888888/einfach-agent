import { describe, expect, it, vi } from 'vitest'
import { AgentHistoryError } from '@einfach-agent/core/history'
import type { ToolContext } from '@einfach-agent/core/tools'
import { createToolRegistry } from '@einfach-agent/core/tools'
import { readAgentHistoryItemTool } from './read-agent-history-item'

const target = { kind: 'root' as const, conversationId: 'c' }
const ctx = (agentHistory?: ToolContext['agentHistory']) => ({ agentHistory } as ToolContext)

describe('read_agent_history_item', () => {
  it('rejects an invalid target union and unknown keys', async () => {
    const registry = createToolRegistry(); registry.register(readAgentHistoryItemTool)
    const readItem = vi.fn()
    const result = await registry.run('read_agent_history_item', {
      target: { kind: 'root', conversationId: 'c', agentPath: 'root-01' }, itemId: 'i', extra: 1,
    }, ctx({ readItem } as never))
    expect(result).toMatchObject({ ok: false })
    expect(readItem).not.toHaveBeenCalled()
  })

  it('preserves text paging metadata and warnings', async () => {
    const data = { item: { itemId: 'i' }, text: 'body', offset: 0, nextOffset: 4,
      totalChars: 8, warnings: [{ code: 'LEGACY_PARTIAL_HISTORY' as const, message: 'partial' }] }
    const readItem = vi.fn(async () => data)
    await expect(readAgentHistoryItemTool.execute({ target, itemId: 'i' }, ctx({ readItem } as never)))
      .resolves.toEqual({ ok: true, data })
  })

  it('returns stable unavailable and typed errors', async () => {
    await expect(readAgentHistoryItemTool.execute({ target, itemId: 'i' }, ctx())).resolves.toMatchObject({
      ok: false, code: 'AGENT_HISTORY_UNAVAILABLE',
    })
    const readItem = vi.fn(async () => { throw new AgentHistoryError('AGENT_HISTORY_ITEM_DELETED', 'deleted') })
    await expect(readAgentHistoryItemTool.execute({ target, itemId: 'i' }, ctx({ readItem } as never)))
      .resolves.toMatchObject({ ok: false, code: 'AGENT_HISTORY_ITEM_DELETED' })
  })
})
