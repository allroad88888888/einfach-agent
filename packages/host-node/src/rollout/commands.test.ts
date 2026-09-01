import { describe, expect, it, vi } from 'vitest'

import type { AgentRolloutDriver } from '@einfach-agent/core/history'
import { createRolloutRoutes } from './commands'

function fakeDriver(): AgentRolloutDriver {
  return {
    append: vi.fn(async () => ({ records: [] })),
    reconcile: vi.fn(async () => ({ histories: [] })),
    flush: vi.fn(async () => undefined),
  }
}

describe('rollout commands', () => {
  it('accepts a codec-valid append input before calling the driver', async () => {
    const driver = fakeDriver()
    const handler = createRolloutRoutes(driver).agent_rollout_append!
    await handler({
      target: { kind: 'root', conversationId: 'conversation' },
      mutations: [{ mutationType: 'item_upsert', target: { kind: 'root', conversationId: 'conversation' },
        itemId: 'item', itemOrdinal: 0, createdAt: 1, item: { role: 'user', content: 'hello' },
        pending: false, planStageId: null }],
    })
    expect(driver.append).toHaveBeenCalledWith(
      { kind: 'root', conversationId: 'conversation' },
      [expect.objectContaining({ pending: false, planStageId: null })],
    )
  })

  it('rejects invalid and oversized input without reaching the driver', async () => {
    const driver = fakeDriver()
    const handler = createRolloutRoutes(driver).agent_rollout_append!
    await expect(handler({ target: { kind: 'root' }, mutations: [] })).rejects.toThrow()
    await expect(handler({ target: { kind: 'root', conversationId: 'c' },
      mutations: Array.from({ length: 1_001 }, () => ({})) })).rejects.toThrow('bounded array')
    expect(driver.append).not.toHaveBeenCalled()
  })

  it('accepts no arguments for reconcile', async () => {
    const driver = fakeDriver()
    const handler = createRolloutRoutes(driver).agent_rollout_reconcile!
    await expect(handler({})).resolves.toEqual({ histories: [] })
    await expect(handler({ path: '/tmp/raw' })).rejects.toThrow('invalid fields')
  })

  it('strictly rejects extra fields, mismatched targets, incomplete items, and defaults', async () => {
    const driver = fakeDriver()
    const handler = createRolloutRoutes(driver).agent_rollout_append!
    const target = { kind: 'root', conversationId: 'c' }
    const base = { mutationType: 'item_upsert', target, itemId: 'i', itemOrdinal: 0, createdAt: 0,
      item: { role: 'user', content: 'x' }, pending: false, planStageId: null }
    await expect(handler({ target, mutations: [{ ...base, extra: true }] })).rejects.toThrow('not allowed')
    await expect(handler({ target, mutations: [{ ...base, schemaVersion: 1 }] })).rejects.toThrow('not allowed')
    await expect(handler({ target, mutations: [{ ...base, pending: undefined }] })).rejects.toThrow()
    await expect(handler({ target, mutations: [{ ...base, item: { role: 'admin' } }] })).rejects.toThrow()
    await expect(handler({ target, mutations: [{ ...base,
      target: { kind: 'root', conversationId: 'other' } }] })).rejects.toThrow('does not match')
    expect(driver.append).not.toHaveBeenCalled()
  })
})
