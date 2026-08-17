import { describe, expect, it } from 'vitest'
import type { HistoryStackState } from '@einfach/core'
import { createCore } from '../runtime/core/createCore'
import { itemsAtom } from './sessionAtoms'
import { appendItem, setRun } from './sessionWriters'
import { enqueueUserMessage } from './transientAtoms'
import { undoCrossesBarrier } from './undoBarrier'

function stack(txIds: string[], cursor: number): HistoryStackState {
  return {
    entries: txIds.map((txId) => ({ txId, ops: [{ key: 'k', before: 0, after: 1 }] })),
    cursor,
  }
}

describe('undoCrossesBarrier', () => {
  it('没有屏障时永不阻挡', () => {
    expect(undoCrossesBarrier(stack(['a', 'b'], 2), undefined)).toBe(false)
  })

  it('挡住屏障那条本身，以及更早的', () => {
    // 屏障在下标 1；游标 2 时下一个要弹的正是它 → 挡。
    expect(undoCrossesBarrier(stack(['a', 'b', 'c'], 2), 'b')).toBe(true)
    // 游标 1 时下一个要弹的是更早的 'a' → 也挡。
    expect(undoCrossesBarrier(stack(['a', 'b', 'c'], 1), 'b')).toBe(true)
  })

  it('放行屏障之后的条目', () => {
    // 游标 3 时下一个要弹的是 'c'，它比屏障新 → 放行。
    expect(undoCrossesBarrier(stack(['a', 'b', 'c'], 3), 'b')).toBe(false)
  })

  it('屏障被 cap 逐出后全部放行', () => {
    // 剩下的条目全都比那条已消失的屏障新，撤销它们不会越过屏障。
    expect(undoCrossesBarrier(stack(['c', 'd'], 2), 'b')).toBe(false)
  })

  it('无账可退时不谈阻挡', () => {
    expect(undoCrossesBarrier(stack(['a'], 0), 'a')).toBe(false)
  })
})

describe('显式停止 run 之后的撤销', () => {
  function coreWithDisposer() {
    const disposed: unknown[][] = []
    const core = createCore()
    core.config.disposeUserContent = (discarded) => { disposed.push([...discarded]) }
    const id = core.newSession({ settings: { vendor: 'test', model: 'test-model' } })
    core.selectSession(id)
    return { core, id, disposed }
  }

  it('真的释放过内容时立屏障，越过它的撤销被拒绝', () => {
    const { core, id, disposed } = coreWithDisposer()
    setRun(id, { runId: 'run-1', status: 'running', turnId: 't1' }, core)
    appendItem(id, { id: 'u1', createdAt: 1, item: { role: 'user', content: '第一问' } }, core)
    // 排队消息带着自己的内容；停止会清空排队，于是这份内容变成不可达 → 被释放。
    enqueueUserMessage(id, {
      id: 'q1', createdAt: 2, content: '排队里的话', targetRunId: 'run-1', submissionSequence: 1,
    }, core)

    core.stopRun()
    expect(disposed).toHaveLength(1)

    // 释放已经发出去、收不回来；撤销回去只会得到指向已删除上传的坏引用。
    expect(core.undoTurn()).toMatchObject({ ok: false, refusal: 'irreversible_barrier' })
    expect(core.getSessionStore(id).store.getter(itemsAtom)).toHaveLength(1)
    // UI 的可用态必须与命令的拒绝同源，否则按钮亮着而命令拒绝。
    const session = core.getSessionStore(id)
    expect(session.store.getter(session.history.undoAvailabilityAtom)).toMatchObject({
      canUndo: false,
      blocked: 'irreversible_barrier',
    })
  })

  it('什么都没释放时不立屏障，撤销照常可用', () => {
    const { core, id, disposed } = coreWithDisposer()
    setRun(id, { runId: 'run-1', status: 'running', turnId: 't1' }, core)
    appendItem(id, { id: 'u1', createdAt: 1, item: { role: 'user', content: '第一问' } }, core)

    core.stopRun()

    // 没有排队内容 → 没有东西变成不可达 → 一次释放都没发出。
    expect(disposed).toEqual([])
    expect(core.undoTurn().ok).toBe(true)
  })

  it('屏障之后新产生的那一轮仍然可以撤销', () => {
    const { core, id } = coreWithDisposer()
    setRun(id, { runId: 'run-1', status: 'running', turnId: 't1' }, core)
    enqueueUserMessage(id, {
      id: 'q1', createdAt: 2, content: '排队里的话', targetRunId: 'run-1', submissionSequence: 1,
    }, core)
    core.stopRun()

    // 屏障之后的新一轮不受它约束 —— 屏障只封住「更早」，不是把撤销永久关掉。
    setRun(id, { runId: 'run-2', status: 'running', turnId: 't2' }, core)
    appendItem(id, { id: 'u2', createdAt: 3, item: { role: 'user', content: '第二问' } }, core)
    setRun(id, { runId: 'run-2', status: 'done', turnId: 't2' }, core)

    expect(core.undoTurn().ok).toBe(true)
    expect(core.getSessionStore(id).store.getter(itemsAtom)).toHaveLength(0)
    // 再退一次就要越过屏障了。
    expect(core.undoTurn()).toMatchObject({ ok: false, refusal: 'irreversible_barrier' })
  })
})
