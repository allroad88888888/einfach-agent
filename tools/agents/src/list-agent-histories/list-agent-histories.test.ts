import { describe, expect, it, vi } from 'vitest'
import { AgentHistoryError } from '@einfach-agent/core/history'
import type { ToolContext } from '@einfach-agent/core/tools'
import { createToolRegistry } from '@einfach-agent/core/tools'
import { listAgentHistoriesTool } from './list-agent-histories'

const ctx = (agentHistory?: ToolContext['agentHistory']) => ({ agentHistory } as ToolContext)

describe('list_agent_histories', () => {
  it('declares a strict target union and rejects unknown keys before execution', async () => {
    const registry = createToolRegistry(); registry.register(listAgentHistoriesTool)
    const listHistories = vi.fn()
    const result = await registry.run('list_agent_histories', {
      target: { kind: 'root', conversationId: 'c', runId: 'forbidden' }, extra: true,
    }, ctx({ listHistories } as never))
    expect(result).toMatchObject({ ok: false })
    expect(listHistories).not.toHaveBeenCalled()
  })

  it('passes structured warnings and cursors through unchanged', async () => {
    const data = { histories: [], nextCursor: 'next', warnings: [{ code: 'PROJECTION_LAG' as const, message: 'lag' }] }
    const listHistories = vi.fn(async () => data)
    await expect(listAgentHistoriesTool.execute({ limit: 2 }, ctx({ listHistories } as never)))
      .resolves.toEqual({ ok: true, data })
    expect(listHistories).toHaveBeenCalledWith({ limit: 2 })
  })

  it('returns stable unavailable and provider failures', async () => {
    await expect(listAgentHistoriesTool.execute({}, ctx())).resolves.toMatchObject({
      ok: false, code: 'AGENT_HISTORY_UNAVAILABLE', retryable: false,
    })
    const listHistories = vi.fn(async () => { throw new AgentHistoryError('AGENT_HISTORY_SOURCE_CORRUPT', 'bad source') })
    await expect(listAgentHistoriesTool.execute({}, ctx({ listHistories } as never))).resolves.toMatchObject({
      ok: false, code: 'AGENT_HISTORY_SOURCE_CORRUPT', retryable: false,
    })
  })
})
