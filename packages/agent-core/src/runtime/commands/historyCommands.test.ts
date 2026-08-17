import { describe, expect, it } from 'vitest'
import { createCore } from '../core/createCore'
import { itemsAtom, runAtom } from '../../state/sessionAtoms'
import { composerDraftAtom } from '../../state/sessionTransientAtoms'
import { appendItem, patchRun, setRun } from '../../state/sessionWriters'
import { setComposerDraft } from '../../state/transientAtoms'

type Core = ReturnType<typeof createCore>

function seeded() {
  const core = createCore()
  const id = core.newSession({ settings: { vendor: 'test', model: 'test-model' } })
  core.selectSession(id)
  return { core, id }
}

/** 走真实写入器跑一整轮，产生的条目全部带同一个轮标签。 */
function turn(core: Core, id: string, turnId: string, text: string) {
  setRun(id, { runId: `run-${turnId}`, status: 'running', turnId }, core)
  appendItem(id, { id: turnId, createdAt: 1, item: { role: 'user', content: text } }, core)
  appendItem(id, { id: `${turnId}-a`, createdAt: 2, item: { role: 'assistant', content: '好' } }, core)
  patchRun(id, { status: 'done' }, core)
}

describe('undoTurn / redoTurn', () => {
  it('rolls back a whole turn in one press, not one write at a time', () => {
    const { core, id } = seeded()
    const history = core.getSessionStore(id).history

    turn(core, id, 'u1', '第一问')
    const afterFirst = core.getSessionStore(id).store.getter(itemsAtom)
    turn(core, id, 'u2', '第二问')

    // 一轮产生好几条细粒度条目；按条撤销对用户没有意义，所以默认按轮。
    expect(history.getState().entries.length).toBeGreaterThan(2)

    const undone = core.undoTurn()
    expect(undone.ok).toBe(true)
    expect(undone.entries).toBeGreaterThan(1)
    expect(core.getSessionStore(id).store.getter(itemsAtom)).toEqual(afterFirst)

    const redone = core.redoTurn()
    expect(redone.ok).toBe(true)
    expect(core.getSessionStore(id).store.getter(itemsAtom).map((entry) => entry.id))
      .toEqual(['u1', 'u1-a', 'u2', 'u2-a'])
  })

  it('stops at the turn boundary instead of eating the previous turn', () => {
    const { core, id } = seeded()
    turn(core, id, 'u1', '第一问')
    turn(core, id, 'u2', '第二问')

    core.undoTurn()

    // 第一轮必须完整留下 —— 「弹到标签变化为止」就是为了这一条。
    expect(core.getSessionStore(id).store.getter(itemsAtom).map((entry) => entry.id))
      .toEqual(['u1', 'u1-a'])
    expect(core.getSessionStore(id).store.getter(runAtom)?.turnId).toBe('u1')
  })

  it('treats an unlabelled write as its own step so unrelated edits survive', () => {
    const { core, id } = seeded()
    // 尚无 run 时的输入框草稿不属于任何一轮；成组回滚会把不相关的编辑一起吃掉。
    setComposerDraft(id, '草稿一', core)
    setComposerDraft(id, '草稿一二', core)

    expect(core.undoTurn()).toEqual({ ok: true, entries: 1 })
    expect(core.getSessionStore(id).store.getter(composerDraftAtom)).toBe('草稿一')
  })

  it('refuses while the run is still in flight', () => {
    const { core, id } = seeded()
    turn(core, id, 'u1', '第一问')
    setRun(id, { runId: 'run-live', status: 'running', turnId: 'u2' }, core)

    // 在飞的 run 会在 await 之后继续写这个 store；此刻回滚会让已回滚的世界再被写入。
    // 放开成「撤销时自动停 run」需要先补 epoch 守卫，不在本命令里偷偷做。
    expect(core.undoTurn()).toEqual({ ok: false, refusal: 'run_in_flight', entries: 0 })
    expect(core.getSessionStore(id).store.getter(itemsAtom)).toHaveLength(2)
  })

  it('reports an empty log instead of pretending it worked', () => {
    const { core } = seeded()
    expect(core.undoTurn()).toEqual({ ok: false, refusal: 'nothing_to_apply', entries: 0 })
    expect(core.redoTurn()).toEqual({ ok: false, refusal: 'nothing_to_apply', entries: 0 })
  })

  it('offers a single-entry granularity for a developer timeline', () => {
    const { core, id } = seeded()
    turn(core, id, 'u1', '第一问')
    const before = core.getSessionStore(id).history.getState().cursor

    expect(core.undoEntry()).toEqual({ ok: true, entries: 1 })
    expect(core.getSessionStore(id).history.getState().cursor).toBe(before - 1)
  })
})
