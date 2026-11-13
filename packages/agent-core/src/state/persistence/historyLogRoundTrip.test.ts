// 撤销日志的落盘往返 —— 「刷新之后还能撤销」这句话的兑现测试。
import { describe, expect, it } from 'vitest'
import { createCore } from '../../runtime/core/createCore'
import { createMemoryRecoveryDriver } from './recoveryDriver'
import { createMemoryHistoryLogDriver, type HistoryLogDriver } from './historyLogDriver'
import { contextCheckpointAtom, itemsAtom } from '../sessionAtoms'
import { appendItem, setContextCheckpointOnSession, setRun } from '../sessionWriters'
import { enqueueUserMessage } from '../transientAtoms'
import type { SessionsPersistence } from './contract'
import type { SessionMeta, WorkspaceMeta } from '../core.type'
import { markUndoBarrier } from '../undoBarrier'

function memorySessions(): SessionsPersistence & { sessions: SessionMeta[] } {
  const state: { sessions: SessionMeta[]; workspaces: WorkspaceMeta[] } = { sessions: [], workspaces: [] }
  return {
    get sessions() { return state.sessions },
    async saveSessions(sessions) { state.sessions = sessions },
    async loadSessions() { return state.sessions },
    async saveWorkspaces(workspaces) { state.workspaces = workspaces },
    async loadWorkspaces() { return state.workspaces },
  }
}

/** 一个装好持久化的 core；两次调用共享同一对 driver = 模拟刷新。 */
function hostedCore(sessions: SessionsPersistence, recovery: ReturnType<typeof createMemoryRecoveryDriver>, historyLog: HistoryLogDriver) {
  const core = createCore()
  core.persistence.configure({
    sessions,
    recovery,
    recoveryStore: (id) => core.findSessionStore(id)?.store,
    historyLog,
    historyFor: (id) => core.findSessionStore(id)?.history,
  })
  return core
}

async function seedAndPersist(sessions: SessionsPersistence, recovery: ReturnType<typeof createMemoryRecoveryDriver>, historyLog: HistoryLogDriver) {
  const core = hostedCore(sessions, recovery, historyLog)
  const id = core.newSession({ settings: { vendor: 'test', model: 'test-model' } })
  core.selectSession(id)
  setRun(id, { runId: 'run-1', status: 'running', turnId: 't1' }, core)
  appendItem(id, { id: 'u1', createdAt: 1, item: { role: 'user', content: '第一问' } }, core)
  appendItem(id, { id: 'a1', createdAt: 2, item: { role: 'assistant', content: '答' } }, core)
  core.persistence.persistSessions()
  const outcome = await core.persistence.persistRecovery(id, 'test')
  await core.persistence.flushRecovery()
  return { core, id, outcome }
}

describe('撤销日志的落盘往返', () => {
  it('超过一千笔事务持久化恢复后仍能撤回最早消息与后续 checkpoint', async () => {
    const sessions = memorySessions()
    const recovery = createMemoryRecoveryDriver()
    const historyLog = createMemoryHistoryLogDriver()
    const origin = hostedCore(sessions, recovery, historyLog)
    const id = origin.newSession({ settings: { vendor: 'test', model: 'test-model' } })
    origin.selectSession(id)
    for (let index = 0; index < 1_205; index += 1) {
      appendItem(id, {
        id: `u${index}`,
        createdAt: index,
        item: { role: 'user', content: `第${index}问` },
      }, origin)
      if (index === 602) {
        setContextCheckpointOnSession(origin.getSessionStore(id), {
          schemaVersion: 1,
          summary: '前半段摘要',
          coveredItemIds: Array.from({ length: 603 }, (_, at) => `u${at}`),
          createdAt: index,
          sourceEstimatedTokens: 6_030,
        })
      }
    }
    origin.persistence.persistSessions()
    expect((await origin.persistence.persistRecovery(id, 'long_history'))?.status).toBe('saved')

    const revived = hostedCore(sessions, recovery, historyLog)
    expect(await revived.persistence.hydrate()).toBe(true)
    const session = revived.getSessionStore(id)
    expect(session.history.getState().entries).toHaveLength(1_206)
    const turns = session.store.getter(revived.sessionTurnHistoryAtom(id)).turns
    expect([turns[0]?.blocked, turns[602]?.blocked, turns[1_204]?.blocked]).toEqual([
      undefined, undefined, undefined,
    ])
    expect(session.store.getter(contextCheckpointAtom)?.summary).toBe('前半段摘要')

    expect(revived.retractTurn('u0', id)).toMatchObject({ ok: true, entries: 1_206 })
    expect(session.store.getter(itemsAtom)).toEqual([])
    expect(session.store.getter(contextCheckpointAtom)).toBeUndefined()
  })

  it('刷新之后还能撤销刚才那一轮', async () => {
    const sessions = memorySessions()
    const recovery = createMemoryRecoveryDriver()
    const historyLog = createMemoryHistoryLogDriver()
    const { id, outcome } = await seedAndPersist(sessions, recovery, historyLog)
    expect(outcome?.status).toBe('saved')

    // 新进程：全新 core，同一对 driver。
    const revived = hostedCore(sessions, recovery, historyLog)
    expect(await revived.persistence.hydrate()).toBe(true)

    const session = revived.getSessionStore(id)
    expect(session.store.getter(itemsAtom).map((entry) => entry.id)).toEqual(['u1', 'a1'])
    // 账本活过来了：条目在，游标在末尾。
    expect(session.history.getState().entries.length).toBeGreaterThan(0)

    // run 在恢复归类里已从 running 落成中断态，所以这一次不涉及「先停 run」那条路。
    // 三次写入（setRun / append u1 / append a1）共享轮标签 t1，所以一次 undoTurn 退掉整轮。
    const undone = revived.undoTurn()
    expect(undone.ok).toBe(true)
    expect(undone.entries).toBe(3)
    expect(session.store.getter(itemsAtom)).toEqual([])

    // 再重做回来，证明落盘的是完整的双向账本，不只是「能退一次」。
    expect(revived.redoTurn().ok).toBe(true)
    expect(session.store.getter(itemsAtom).map((entry) => entry.id)).toEqual(['u1', 'a1'])
  })

  it('撤回后的消息占位与目标式恢复从持久化日志重建', async () => {
    const sessions = memorySessions()
    const recovery = createMemoryRecoveryDriver()
    const historyLog = createMemoryHistoryLogDriver()
    const { core, id } = await seedAndPersist(sessions, recovery, historyLog)
    expect(core.retractTurn('u1', id).ok).toBe(true)
    await core.persistence.flushRecovery()

    const revived = hostedCore(sessions, recovery, historyLog)
    expect(await revived.persistence.hydrate()).toBe(true)
    const session = revived.getSessionStore(id)
    expect(session.store.getter(itemsAtom)).toEqual([])
    expect(session.store.getter(revived.sessionTurnHistoryAtom(id)).turns).toMatchObject([
      { state: 'retracted', userItem: { id: 'u1' } },
    ])
    expect(revived.restoreRetractedTurn('u1', id).ok).toBe(true)
    expect(session.store.getter(itemsAtom).map((item) => item.id)).toEqual(['u1', 'a1'])
    await revived.persistence.flushRecovery()

    const revivedAgain = hostedCore(sessions, recovery, historyLog)
    expect(await revivedAgain.persistence.hydrate()).toBe(true)
    const restored = revivedAgain.getSessionStore(id)
    expect(restored.store.getter(itemsAtom).map((item) => item.id)).toEqual(['u1', 'a1'])
    expect(restored.store.getter(revivedAgain.sessionTurnHistoryAtom(id)).turns).toMatchObject([
      { state: 'active', userItem: { id: 'u1' } },
    ])
  })

  it('快照只绑定已确认的日志，忽略其后的未提交分支', async () => {
    const sessions = memorySessions()
    const recovery = createMemoryRecoveryDriver()
    const historyLog = createMemoryHistoryLogDriver()
    const { id } = await seedAndPersist(sessions, recovery, historyLog)
    const snapshot = (await recovery.loadLatest(id))!
    await historyLog.append(id, {
      version: 1, id: 'uncommitted', parent: snapshot.historyRef!.head,
      operations: [{ type: 'dropAfter', cursor: 0 }, { type: 'setCursor', cursor: 0 }],
    })
    const revived = hostedCore(sessions, recovery, historyLog)
    expect(await revived.persistence.hydrate()).toBe(true)
    expect(revived.getSessionStore(id).history.getState().entries).toHaveLength(3)
    expect(revived.undoTurn()).toMatchObject({ ok: true, entries: 3 })
    expect((await recovery.loadLatest(id))!).not.toHaveProperty('history')
  })

  it('撤销屏障跟着日志一起活过刷新', async () => {
    const sessions = memorySessions()
    const recovery = createMemoryRecoveryDriver()
    const historyLog = createMemoryHistoryLogDriver()

    // 先造一个真实的不可逆释放：排队消息在停止时被清空，其内容变成不可达 → 被释放 → 立屏障。
    const core = hostedCore(sessions, recovery, historyLog)
    core.config.disposeUserContent = () => {}
    const id = core.newSession({ settings: { vendor: 'test', model: 'test-model' } })
    core.selectSession(id)
    setRun(id, { runId: 'run-1', status: 'running', turnId: 't1' }, core)
    appendItem(id, { id: 'u1', createdAt: 1, item: { role: 'user', content: '第一问' } }, core)
    enqueueUserMessage(id, {
      id: 'q1', createdAt: 2, content: '排队里的话', targetRunId: 'run-1', submissionSequence: 1,
    }, core)
    core.stopRun()
    markUndoBarrier(core.getSessionStore(id))
    expect(core.undoTurn()).toMatchObject({ ok: false, refusal: 'irreversible_barrier' })

    core.persistence.persistSessions()
    expect((await core.persistence.persistRecovery(id, 'test'))?.status).toBe('saved')
    await core.persistence.flushRecovery()
    expect((await recovery.loadLatest(id))?.historyRef?.barrierTxId).toBeDefined()

    const revived = hostedCore(sessions, recovery, historyLog)
    expect(await revived.persistence.hydrate()).toBe(true)

    // 屏障若不跟着落盘，刷新之后撤销就能越过一个已经发生的删除 —— 状态回来了、上传没回来。
    expect(revived.undoTurn()).toMatchObject({ ok: false, refusal: 'irreversible_barrier' })
  })

  it('删除会话后旧日志不会复活恢复状态', async () => {
    const sessions = memorySessions()
    const recovery = createMemoryRecoveryDriver()
    const historyLog = createMemoryHistoryLogDriver()
    const { core, id } = await seedAndPersist(sessions, recovery, historyLog)
    const snapshot = (await recovery.loadLatest(id))!
    core.persistence.persistDeleteSession(id)
    await core.persistence.flushRecovery()
    expect(await recovery.loadLatest(id)).toBeUndefined()
    expect(await recovery.saveLatest(id, snapshot)).toEqual({ status: 'tombstoned' })
    // Journal evidence is retained, but only a live recovery record can select it.
    expect((await historyLog.load(id, snapshot.historyRef!.head)).entries).toHaveLength(3)
  })
})
