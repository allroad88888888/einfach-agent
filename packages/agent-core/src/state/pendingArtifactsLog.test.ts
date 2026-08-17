import { describe, expect, it } from 'vitest'
import { createCore } from '../runtime/core/createCore'
import { pendingArtifactsAtom } from './sessionTransientAtoms'
import { addPendingArtifact, removePendingArtifact } from './sessionTransientMutations'

function seeded() {
  const core = createCore()
  const id = core.newSession({ settings: { vendor: 'test', model: 'test-model' } })
  core.selectSession(id)
  return { core, id, session: core.getSessionStore(id) }
}

function artifact(id: string, bytes = 16) {
  return { id, filename: `${id}.txt`, content: 'x'.repeat(bytes) }
}

function ids(core: ReturnType<typeof createCore>, id: string): string[] {
  return core.getSessionStore(id).store.getter(pendingArtifactsAtom).map((entry) => entry.id)
}

describe('待保存产物的记账大小', () => {
  it('暂存一个产物的账不含已攒下的其他产物正文', () => {
    // 整值记账下这条必挂：before/after 各存一份完整列表，含之前每个产物的完整文件正文。
    function bytesAfter(existing: number): number {
      const { core, id, session } = seeded()
      for (let index = 0; index < existing; index += 1) {
        addPendingArtifact(id, artifact(`old${index}`, 4096), core)
      }
      addPendingArtifact(id, artifact('measured'), core)
      const { entries } = session.history.getState()
      return JSON.stringify(entries[entries.length - 1]?.ops).length
    }
    expect(bytesAfter(50)).toBe(bytesAfter(1))
    expect(bytesAfter(50)).toBeLessThan(1024)
  })
})

describe('产物移除的逆操作', () => {
  it('撤销把产物插回原来的位置，而不是接到末尾', () => {
    const { core, id } = seeded()
    addPendingArtifact(id, artifact('a'), core)
    addPendingArtifact(id, artifact('b'), core)
    addPendingArtifact(id, artifact('c'), core)

    removePendingArtifact(id, 'b', core)
    expect(ids(core, id)).toEqual(['a', 'c'])

    // 位置必须还原：产物卡片是按列表顺序渲染的，撤销后跳到末尾等于顺序被悄悄改了。
    expect(core.undoEntry()).toEqual({ ok: true, entries: 1 })
    expect(ids(core, id)).toEqual(['a', 'b', 'c'])

    expect(core.redoEntry()).toEqual({ ok: true, entries: 1 })
    expect(ids(core, id)).toEqual(['a', 'c'])
  })

  it('产物正文在撤销后原样回来', () => {
    const { core, id } = seeded()
    addPendingArtifact(id, { id: 'a', filename: 'a.txt', content: '原始正文' }, core)
    removePendingArtifact(id, 'a', core)

    core.undoEntry()
    expect(core.getSessionStore(id).store.getter(pendingArtifactsAtom)[0]).toEqual({
      id: 'a', filename: 'a.txt', content: '原始正文',
    })
  })

  it('id 不存在时一条账都不记', () => {
    const { core, id, session } = seeded()
    addPendingArtifact(id, artifact('a'), core)
    const before = session.history.getState().entries.length

    removePendingArtifact(id, '不存在', core)

    expect(session.history.getState().entries.length).toBe(before)
  })
})
