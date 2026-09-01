import { createStore } from '@einfach/core'
import { describe, expect, it, vi } from 'vitest'
import { createSessionHistory } from '../state/sessionHistory'
import { flushPersistedHistoryLog } from './persistedHistoryLogFlush'

describe('flushPersistedHistoryLog', () => {
  it('saves only a log paired to a successful recovery generation', async () => {
    const store = createStore()
    const history = createSessionHistory(store)
    const save = vi.fn(async () => {})
    const options = {
      historyLog: { load: async () => undefined, save, deleteSession: async () => {} },
      historyFor: () => history,
      recoveryStore: () => store,
    }

    flushPersistedHistoryLog(options, { status: 'error', sessionId: 's1', error: new Error() }, 's1')
    flushPersistedHistoryLog(options, { status: 'saved', sessionId: 's1', generation: 7, attempts: 1 }, 's1')
    await Promise.resolve()

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('s1', expect.objectContaining({ generation: 7 }))
  })

  it('keeps invalid or failed best-effort logs outside the durability outcome', async () => {
    const save = vi.fn(async () => { throw new Error('log unavailable') })
    const history = { getState: () => ({ entries: [], cursor: 0 }) }
    expect(() => flushPersistedHistoryLog({
      historyLog: { load: async () => undefined, save, deleteSession: async () => {} },
      historyFor: () => history as never,
    }, { status: 'saved', sessionId: 's1', generation: 1, attempts: 1 }, 's1')).not.toThrow()
    await Promise.resolve()
  })
})
