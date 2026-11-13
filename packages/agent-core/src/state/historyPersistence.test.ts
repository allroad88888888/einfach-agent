import { createStore } from '@einfach/core'
import { describe, expect, it, vi } from 'vitest'
import { createSessionHistory } from './sessionHistory'
import { writeRunLogged as setRunOnSession } from './runStateLog'
import { runAtom } from './sessionAtoms'
import { createMemoryHistoryLogDriver } from './persistence/historyLogDriver'

function session() {
  const store = createStore()
  return { store, history: createSessionHistory(store) }
}

describe('incremental atom history persistence', () => {
  it('writes only new operations after 1,000 transactions; undo persists only the cursor', async () => {
    const target = session()
    const driver = createMemoryHistoryLogDriver()
    const append = vi.spyOn(driver, 'append')
    for (let i = 0; i < 1_000; i++) {
      setRunOnSession(target, { runId: 'r', status: 'running', startedAt: i })
      await target.history.persistence.capture().flush(driver, 's')
    }
    expect(append).toHaveBeenCalledTimes(1_000)
    expect(append.mock.calls.every(([, batch]) => batch.operations.length === 2)).toBe(true)
    expect(JSON.stringify(append.mock.calls.at(-1)![1]).length).toBeLessThan(500)
    expect(target.history.undo()).toBe(true)
    const capture = target.history.persistence.capture()
    await capture.flush(driver, 's')
    expect(append.mock.calls.at(-1)![1].operations).toEqual([{ type: 'setCursor', cursor: 999 }])
    const loaded = await driver.load('s', capture.head)
    expect(loaded.entries).toHaveLength(1_000)
    expect(loaded.cursor).toBe(999)
    await target.history.persistence.capture().flush(driver, 's')
    expect(append).toHaveBeenCalledTimes(1_001)
  })

  it('keeps failed batches for retry and does not flush changes after a capture', async () => {
    const target = session()
    const driver = createMemoryHistoryLogDriver()
    const append = vi.spyOn(driver, 'append').mockRejectedValueOnce(new Error('disk full'))
    setRunOnSession(target, { runId: 'r', status: 'running' })
    const first = target.history.persistence.capture()
    setRunOnSession(target, { runId: 'r', status: 'done' })
    await expect(first.flush(driver, 's')).rejects.toThrow('disk full')
    await first.flush(driver, 's')
    expect((await driver.load('s', first.head)).cursor).toBe(1)
    const second = target.history.persistence.capture()
    await second.flush(driver, 's')
    expect((await driver.load('s', second.head)).cursor).toBe(2)
    expect(append.mock.calls[0]![1].id).toBe(append.mock.calls[1]![1].id)
  })

  it('restores the selected branch and continues without uploading old entries', async () => {
    const origin = session()
    const driver = createMemoryHistoryLogDriver()
    setRunOnSession(origin, { runId: 'r', status: 'running' })
    const selected = origin.history.persistence.capture()
    await selected.flush(driver, 's')
    setRunOnSession(origin, { runId: 'r', status: 'error' })
    const abandoned = origin.history.persistence.capture()
    await abandoned.flush(driver, 's')

    const restored = session()
    restored.store.setter(runAtom, { runId: 'r', status: 'running' })
    restored.history.persistence.restore(selected.head)
    restored.history.hydrate(await driver.load('s', selected.head))
    setRunOnSession(restored, { runId: 'r', status: 'done' })
    const next = restored.history.persistence.capture()
    await next.flush(driver, 's')
    expect((await driver.load('s', next.head)).entries).toHaveLength(2)
    expect(restored.history.undo()).toBe(true)
    setRunOnSession(restored, { runId: 'r', status: 'stopped' })
    const branch = restored.history.persistence.capture()
    await branch.flush(driver, 's')
    expect(await driver.load('s', branch.head)).toEqual(JSON.parse(JSON.stringify(restored.history.getState())))
    expect((await driver.load('s', abandoned.head)).entries).toHaveLength(2)
  })
})
