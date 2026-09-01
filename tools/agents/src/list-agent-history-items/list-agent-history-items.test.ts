import { describe, expect, it, vi } from 'vitest'
import { AgentHistoryError } from '@einfach-agent/core/history'
import type { ToolContext } from '@einfach-agent/core/tools'
import { createToolRegistry } from '@einfach-agent/core/tools'
import { listAgentHistoryItemsTool } from './list-agent-history-items'

const target = { kind: 'child' as const, conversationId: 'c', runId: 'r', agentPath: 'root-01' }
const ctx = (agentHistory?: ToolContext['agentHistory']) => ({ agentHistory } as ToolContext)

describe('list_agent_history_items', () => {
  it('rejects malformed child targets and unknown keys', async () => {
    const registry = createToolRegistry(); registry.register(listAgentHistoryItemsTool)
    const listItems = vi.fn()
    const result = await registry.run('list_agent_history_items', {
      target: { kind: 'child', conversationId: 'c', runId: 'r' }, unknown: true,
    }, ctx({ listItems } as never))
    expect(result).toMatchObject({ ok: false })
    expect(listItems).not.toHaveBeenCalled()
  })

  it('passes the structured page through unchanged', async () => {
    const data = { history: { historyId: 'h' }, items: [], nextCursor: 'next', warnings: [] }
    const listItems = vi.fn(async () => data)
    await expect(listAgentHistoryItemsTool.execute({ target, roles: ['assistant'] }, ctx({ listItems } as never)))
      .resolves.toEqual({ ok: true, data })
    expect(listItems).toHaveBeenCalledWith({ target, roles: ['assistant'] })
  })

  it('returns stable unavailable and typed errors', async () => {
    await expect(listAgentHistoryItemsTool.execute({ target }, ctx())).resolves.toMatchObject({
      ok: false, code: 'AGENT_HISTORY_UNAVAILABLE',
    })
    const listItems = vi.fn(async () => { throw new AgentHistoryError('AGENT_HISTORY_CURSOR_STALE', 'stale') })
    await expect(listAgentHistoryItemsTool.execute({ target }, ctx({ listItems } as never))).resolves.toMatchObject({
      ok: false, code: 'AGENT_HISTORY_CURSOR_STALE', retryable: false,
    })
  })
})
