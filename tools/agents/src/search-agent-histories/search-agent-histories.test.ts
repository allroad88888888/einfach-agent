import { describe, expect, it, vi } from 'vitest'
import { AgentHistoryError } from '@einfach-agent/core/history'
import type { ToolContext } from '@einfach-agent/core/tools'
import { createToolRegistry } from '@einfach-agent/core/tools'
import { searchAgentHistoriesTool } from './search-agent-histories'

const ctx = (agentHistory?: ToolContext['agentHistory']) => ({ agentHistory } as ToolContext)

describe('search_agent_histories', () => {
  it('rejects unknown keys and malformed targets before execution', async () => {
    const registry = createToolRegistry(); registry.register(searchAgentHistoriesTool)
    const search = vi.fn()
    const result = await registry.run('search_agent_histories', {
      query: 'needle', target: { kind: 'child', conversationId: 'c', runId: 'r' }, extra: true,
    }, ctx({ search } as never))
    expect(result).toMatchObject({ ok: false })
    expect(search).not.toHaveBeenCalled()
  })

  it('passes hits, warnings, and cursor through unchanged', async () => {
    const data = { hits: [], nextCursor: 'next', warnings: [{ code: 'SEARCH_INDEX_LAG' as const, message: 'lag' }] }
    const search = vi.fn(async () => data)
    await expect(searchAgentHistoriesTool.execute({ query: 'needle' }, ctx({ search } as never)))
      .resolves.toEqual({ ok: true, data })
    expect(search).toHaveBeenCalledWith({ query: 'needle' })
  })

  it('returns stable unavailable and typed errors', async () => {
    await expect(searchAgentHistoriesTool.execute({ query: 'needle' }, ctx())).resolves.toMatchObject({
      ok: false, code: 'AGENT_HISTORY_UNAVAILABLE',
    })
    const search = vi.fn(async () => { throw new AgentHistoryError('AGENT_HISTORY_INVALID_CURSOR', 'bad cursor') })
    await expect(searchAgentHistoriesTool.execute({ query: 'needle' }, ctx({ search } as never)))
      .resolves.toMatchObject({ ok: false, code: 'AGENT_HISTORY_INVALID_CURSOR' })
  })
})
