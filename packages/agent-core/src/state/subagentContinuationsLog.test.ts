import { describe, expect, it } from 'vitest'
import { createCore } from '../runtime/core/createCore'
import { subagentContinuationsAtom } from './subagentContinuationAtoms'
import type { SubagentContinuationV1 } from './recoverySnapshot.type'
import {
  appendSubagentContinuationLogged,
  patchSubagentContinuationLogged,
} from './subagentContinuationsLog'

function seeded() {
  const core = createCore()
  const id = core.newSession({ settings: { vendor: 'test', model: 'test-model' } })
  core.selectSession(id)
  return { core, id, session: core.getSessionStore(id) }
}

function continuation(childId: string, specBytes = 16): SubagentContinuationV1 {
  return {
    schemaVersion: 1,
    childId,
    parentRunId: 'run-1',
    parentNodeId: null,
    state: 'queued',
    // spec 只是 JsonValue，测试不关心真实的 descriptor 形状，只关心它的字节量会不会被
    // 记账带上——真实场景里这里装的是完整的子任务描述符，常常整段是 delegate 的 prompt。
    spec: 'x'.repeat(specBytes),
  }
}

function childIds(core: ReturnType<typeof createCore>, id: string): string[] {
  return core.getSessionStore(id).store.getter(subagentContinuationsAtom).map((entry) => entry.childId)
}

describe('子 Agent 续跑记账的大小', () => {
  it('追加一条续跑记录的账不含已攒下的其他续跑记录的 spec 正文', () => {
    // 整值记账下这条必挂：before/after 各存一份完整列表，含之前每个子 agent 的完整 spec。
    function bytesAfter(existing: number): number {
      const { session } = seeded()
      for (let index = 0; index < existing; index += 1) {
        appendSubagentContinuationLogged(session, continuation(`old${index}`, 4096))
      }
      appendSubagentContinuationLogged(session, continuation('measured'))
      const { entries } = session.history.getState()
      return JSON.stringify(entries[entries.length - 1]?.ops).length
    }
    expect(bytesAfter(50)).toBe(bytesAfter(1))
    expect(bytesAfter(50)).toBeLessThan(1024)
  })
})

describe('追加的逆操作', () => {
  it('撤销弹掉的正是刚追加的那条', () => {
    const { core, id, session } = seeded()
    appendSubagentContinuationLogged(session, continuation('a'))
    appendSubagentContinuationLogged(session, continuation('b'))

    expect(core.undoEntry()).toEqual({ ok: true, entries: 1 })
    expect(childIds(core, id)).toEqual(['a'])
    expect(core.redoEntry()).toEqual({ ok: true, entries: 1 })
    expect(childIds(core, id)).toEqual(['a', 'b'])
  })
})

describe('按 childId 打补丁的逆操作', () => {
  it('撤销把那一条换回旧状态，且不动别的条目', () => {
    const { core, id, session } = seeded()
    appendSubagentContinuationLogged(session, continuation('a'))
    appendSubagentContinuationLogged(session, continuation('b'))
    patchSubagentContinuationLogged(session, 'a', { state: 'outcome_unknown' })

    expect(core.getSessionStore(id).store.getter(subagentContinuationsAtom)[0]).toMatchObject({
      childId: 'a', state: 'outcome_unknown',
    })
    expect(core.undoEntry()).toEqual({ ok: true, entries: 1 })
    const items = core.getSessionStore(id).store.getter(subagentContinuationsAtom)
    expect(items[0]).toMatchObject({ childId: 'a', state: 'queued' })
    expect(items[1]).toMatchObject({ childId: 'b', state: 'queued' })
  })

  it('id 不存在时一条账都不记', () => {
    const { session } = seeded()
    appendSubagentContinuationLogged(session, continuation('a'))
    const before = session.history.getState().entries.length

    patchSubagentContinuationLogged(session, '不存在', { state: 'outcome_unknown' })

    expect(session.history.getState().entries.length).toBe(before)
  })
})
