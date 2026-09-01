import { describe, expect, it, vi } from 'vitest'
import type { HostInvoke } from '@einfach-agent/core'

import { createServerAgentRolloutDriver, rejectSourceRolloutWarnings } from './serverAgentRolloutDriver'

const target = { kind: 'root' as const, conversationId: 'conversation-1' }
const mutation = {
  mutationType: 'session_meta' as const,
  target,
  title: 'Rollout',
  createdAt: 1,
  updatedAt: 2,
}

describe('server agent rollout driver', () => {
  it('maps append and reconcile commands without changing their payloads or results', async () => {
    const appendResult = { records: [] }
    const reconcileResult = { histories: [] }
    const invokeMock = vi.fn()
    const invoke = invokeMock as HostInvoke
    invokeMock
      .mockResolvedValueOnce(appendResult)
      .mockResolvedValueOnce(reconcileResult)
    const driver = createServerAgentRolloutDriver(invoke)

    await expect(driver.append(target, [mutation])).resolves.toBe(appendResult)
    await expect(driver.reconcile()).resolves.toBe(reconcileResult)

    expect(invokeMock).toHaveBeenNthCalledWith(1, 'agent_rollout_append', { target, mutations: [mutation] })
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'agent_rollout_reconcile', {})
  })

  it('does not turn a host failure into a successful rollout result', async () => {
    const failure = new Error('rollout source is corrupt')
    const invokeMock = vi.fn().mockRejectedValue(failure)
    const invoke = invokeMock as HostInvoke
    const driver = createServerAgentRolloutDriver(invoke)

    await expect(driver.append(target, [mutation])).rejects.toBe(failure)
    await expect(driver.reconcile()).rejects.toBe(failure)
  })

  it('blocks source warnings while allowing a projection warning to be reported', () => {
    expect(() => rejectSourceRolloutWarnings({ histories: [{ historyId: 'x', recordsApplied: 0,
      nextByteOffset: 0, warning: { kind: 'source', code: 'CORRUPT', message: 'bad JSONL' } }] }))
      .toThrow('bad JSONL')

    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(() => rejectSourceRolloutWarnings({ histories: [{ historyId: 'x', recordsApplied: 0,
      nextByteOffset: 0, warning: { kind: 'projection', code: 'LAG', message: 'projection failed' } }] }))
      .not.toThrow()
    expect(warning).toHaveBeenCalledWith('[agent-rollout]', 'projection failed')
    warning.mockRestore()
  })
})
