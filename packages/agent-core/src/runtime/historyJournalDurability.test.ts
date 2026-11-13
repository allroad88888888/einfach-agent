import { describe, expect, it, vi } from 'vitest'
import { createCore } from './core/createCore'
import { setRun } from '../state/sessionWriters'
import { createMemoryHistoryLogDriver, type HistoryLogDriver } from '../state/persistence/historyLogDriver'
import { createMemoryRecoveryDriver, type RecoveryDriver } from '../state/persistence/recoveryDriver'

function hosted(historyLog: HistoryLogDriver, recovery: RecoveryDriver) {
  const core = createCore()
  core.persistence.configure({
    recovery, historyLog,
    recoveryStore: (id) => core.findSessionStore(id)?.store,
    historyFor: (id) => core.findSessionStore(id)?.history,
  })
  const id = core.newSession({ settings: { vendor: 'test', model: 'test' } })
  return { core, id }
}

describe('history durability boundary', () => {
  it('persists a ledger larger than 32 MiB using small incremental requests', async () => {
    const requestBytes: number[] = []
    const historyLog: HistoryLogDriver = {
      async append(sessionId, batch) {
        requestBytes.push(new TextEncoder().encode(JSON.stringify({ sessionId, batch })).byteLength)
      },
      async load() { throw new Error('not used') },
    }
    const recovery = createMemoryRecoveryDriver()
    const { core, id } = hosted(historyLog, recovery)
    for (let i = 0; i < 300; i++) {
      setRun(id, { runId: 'r', status: 'error', error: String(i % 2).repeat(64 * 1024) }, core)
    }
    const history = core.getSessionStore(id).history
    expect(new TextEncoder().encode(JSON.stringify(history.getState())).byteLength).toBeGreaterThan(32 * 1024 * 1024)
    await expect(core.persistence.persistRecovery(id)).resolves.toMatchObject({ status: 'saved' })
    expect(requestBytes.length).toBeGreaterThan(1)
    expect(Math.max(...requestBytes)).toBeLessThan(512 * 1024)
    const snapshot = (await recovery.loadLatest(id))!
    expect(snapshot).not.toHaveProperty('history')
    expect(JSON.stringify(snapshot).length).toBeLessThan(128 * 1024)
    expect(JSON.stringify(snapshot.historyRef).length).toBeLessThan(100)
    const previous = requestBytes.length
    await core.persistence.persistRecovery(id)
    expect(requestBytes).toHaveLength(previous)
  })

  it('does not save or acknowledge recovery before journal durability', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const base = createMemoryHistoryLogDriver()
    const recovery = createMemoryRecoveryDriver()
    const save = vi.spyOn(recovery, 'saveLatest')
    const historyLog: HistoryLogDriver = {
      ...base,
      async append(id, batch) { await gate; await base.append(id, batch) },
    }
    const { core, id } = hosted(historyLog, recovery)
    await core.persistence.flushRecovery()
    save.mockClear()
    setRun(id, { runId: 'r', status: 'running' }, core)
    let acknowledged = false
    const write = core.persistence.persistRecovery(id).then((result) => { acknowledged = true; return result })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(acknowledged).toBe(false)
    expect(save).not.toHaveBeenCalled()
    release()
    await expect(write).resolves.toMatchObject({ status: 'saved' })
    expect(save).toHaveBeenCalledOnce()
  })

  it('retries a durable append whose acknowledgement was lost without duplicating history', async () => {
    const base = createMemoryHistoryLogDriver()
    let loseReply = true
    const historyLog: HistoryLogDriver = {
      ...base,
      async append(id, batch) {
        await base.append(id, batch)
        if (loseReply) { loseReply = false; throw new Error('lost acknowledgement') }
      },
    }
    const recovery = createMemoryRecoveryDriver()
    const { core, id } = hosted(historyLog, recovery)
    setRun(id, { runId: 'r', status: 'running' }, core)
    await expect(core.persistence.persistRecovery(id)).resolves.toMatchObject({ status: 'error' })
    expect((await recovery.loadLatest(id))?.historyRef?.head ?? null).toBeNull()
    await expect(core.persistence.persistRecovery(id)).resolves.toMatchObject({ status: 'saved' })
    const snapshot = (await recovery.loadLatest(id))!
    expect((await base.load(id, snapshot.historyRef!.head)).entries).toHaveLength(1)
  })

  it('keeps the previous snapshot head when recovery saving fails after append', async () => {
    const journal = createMemoryHistoryLogDriver()
    const recovery = createMemoryRecoveryDriver()
    const { core, id } = hosted(journal, recovery)
    setRun(id, { runId: 'r', status: 'running' }, core)
    await core.persistence.persistRecovery(id)
    const committed = (await recovery.loadLatest(id))!
    vi.spyOn(recovery, 'saveLatest').mockRejectedValueOnce(new Error('disk full'))
    setRun(id, { runId: 'r', status: 'done' }, core)
    await expect(core.persistence.persistRecovery(id)).resolves.toMatchObject({ status: 'error' })
    expect((await recovery.loadLatest(id))!.historyRef).toEqual(committed.historyRef)
    expect((await journal.load(id, committed.historyRef!.head)).cursor).toBe(1)
  })
})
