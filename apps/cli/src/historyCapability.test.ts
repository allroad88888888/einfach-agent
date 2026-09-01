import { describe, expect, it, vi } from 'vitest'
import type { AgentRolloutDriver } from '@einfach-agent/core/history'
import type { RecoveryDriver, SqlExecutor } from '@einfach-agent/core/state/persistence'
import { createCliAgentHistoryProvider } from './historyCapability'

describe('CLI agent history capability', () => {
  it('uses the supplied executor, rollout driver, and recovery facade', async () => {
    const select = vi.fn(async (sql: string) => sql.includes('COUNT(*) count') ? [{ count: 0 }] : [])
    const executor = { select, execute: vi.fn() } as unknown as SqlExecutor
    const agentRollout = {
      reconcile: vi.fn(async () => ({ histories: [] })),
      append: vi.fn(), flush: vi.fn(),
    } as unknown as AgentRolloutDriver
    const recovery = { listLatest: vi.fn(async () => []) } as unknown as Pick<RecoveryDriver, 'listLatest'>
    const provider = createCliAgentHistoryProvider({ executor, agentRollout, recovery })

    const target = { kind: 'root' as const, conversationId: 'conversation' }
    await expect(provider.forContext({ legacyWorkspaceRoot: '/workspace' }).listHistories({ target }))
      .resolves.toEqual({ histories: [], warnings: [] })
    expect(agentRollout.reconcile).toHaveBeenCalledOnce()
    expect(select).toHaveBeenCalled()
    expect(recovery.listLatest).toHaveBeenCalledOnce()
  })
})
