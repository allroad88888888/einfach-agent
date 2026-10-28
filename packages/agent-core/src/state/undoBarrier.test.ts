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

  it('可撤回的排队内容不会被释放或制造新屏障', () => {
    const { core, id, disposed } = coreWithDisposer()
    setRun(id, { runId: 'run-1', status: 'running', turnId: 't1' }, core)
    appendItem(id, { id: 'u1', createdAt: 1, item: { role: 'user', content: '第一问' } }, core)
    // 停止会清空排队，但事务日志仍持有可恢复内容。
    enqueueUserMessage(id, {
      id: 'q1', createdAt: 2, content: '排队里的话', targetRunId: 'run-1', submissionSequence: 1,
    }, core)

    core.stopRun()
    expect(disposed).toEqual([])
    expect(core.undoTurn()).toMatchObject({ ok: true })
    const session = core.getSessionStore(id)
    expect(session.store.getter(session.history.undoAvailabilityAtom)).toMatchObject({
      canRedo: true,
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

  it('停止之后的新一轮与更早一轮都保持可撤销', () => {
    const { core, id, disposed } = coreWithDisposer()
    setRun(id, { runId: 'run-1', status: 'running', turnId: 't1' }, core)
    enqueueUserMessage(id, {
      id: 'q1', createdAt: 2, content: '排队里的话', targetRunId: 'run-1', submissionSequence: 1,
    }, core)
    core.stopRun()

    // 新一轮照常记账，停止产生的更早一轮也没有被资源清理封死。
    setRun(id, { runId: 'run-2', status: 'running', turnId: 't2' }, core)
    appendItem(id, { id: 'u2', createdAt: 3, item: { role: 'user', content: '第二问' } }, core)
    setRun(id, { runId: 'run-2', status: 'done', turnId: 't2' }, core)

    expect(core.undoTurn().ok).toBe(true)
    expect(core.getSessionStore(id).store.getter(itemsAtom)).toHaveLength(0)
    expect(core.undoTurn()).toMatchObject({ ok: true })
    expect(disposed).toEqual([])
  })
})
