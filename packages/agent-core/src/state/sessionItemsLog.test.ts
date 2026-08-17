import { describe, expect, it } from 'vitest'
import { createCore } from '../runtime/core/createCore'
import { itemsAtom } from './sessionAtoms'
import { appendItem, setRun, updateItem } from './sessionWriters'
import type { ConversationItem } from './core.type'

type Core = ReturnType<typeof createCore>

function seeded() {
  const core = createCore()
  const id = core.newSession({ settings: { vendor: 'test', model: 'test-model' } })
  core.selectSession(id)
  return { core, id, session: core.getSessionStore(id) }
}

function item(id: string, content = '内容'): ConversationItem {
  return { id, createdAt: 1, item: { role: 'user', content } }
}

/**
 * 只量 ops 载荷，不含 txId。
 *
 * txId 是单调序号，位数随会话长度慢慢变长（`tx-11` → `tx-1001`），那不是这条测试要挡的东西；
 * 要挡的是「载荷随对话长大」。Rust 侧同一条测试也是只量 `changes[0].prev`。
 */
function lastEntryOpBytes(core: Core, id: string): number {
  const { entries } = core.getSessionStore(id).history.getState()
  return JSON.stringify(entries[entries.length - 1]?.ops).length
}

function ids(core: Core, id: string): string[] {
  return core.getSessionStore(id).store.getter(itemsAtom).map((entry) => entry.id)
}

describe('日志条目的大小', () => {
  it('追加一条的账不随对话长度变大', () => {
    // 对齐 einfach-agent-rust 红线 3/5 的兑现测试（`prev` 不随摘要正文长大）。
    // 整值记账下这条必挂：before/after 各存一份完整数组，长对话的 entry 就是长对话那么大。
    function bytesAfter(existing: number): number {
      const { core, id } = seeded()
      for (let index = 0; index < existing; index += 1) appendItem(id, item(`old${index}`), core)
      appendItem(id, item('measured'), core)
      return lastEntryOpBytes(core, id)
    }
    expect(bytesAfter(1000)).toBe(bytesAfter(10))
    // 顺带钉住绝对量级：整值记账下 1000 条对话的这一条 entry 是整个数组那么大。
    expect(bytesAfter(1000)).toBeLessThan(1024)
  })

  it('一整段真实对话的账本远小于对话本身', () => {
    const { core, id } = seeded()
    const toolResult = 'x'.repeat(8 * 1024)
    for (let turn = 1; turn <= 40; turn += 1) {
      setRun(id, { runId: `run-${turn}`, status: 'running', turnId: `t${turn}` }, core)
      appendItem(id, item(`u${turn}`, '看下这个文件'), core)
      appendItem(id, { id: `r${turn}`, createdAt: turn, item: { role: 'tool', tool_call_id: `c${turn}`, content: toolResult } }, core)
    }
    const session = core.getSessionStore(id)
    const conversation = JSON.stringify(session.store.getter(itemsAtom)).length
    const log = JSON.stringify(session.history.getState()).length

    // 整值记账实测：对话 0.32 MB → 日志 33 MB（100 倍）。改成增量后日志只装被动的那些条目，
    // 不可能超过对话本身太多。留 2 倍余量而不是卡死具体字节：这条挡的是「又退回二次开销」。
    expect(log).toBeLessThan(conversation * 2)
  })
})

describe('追加的逆操作', () => {
  it('撤销弹掉的正是刚追加的那条', () => {
    const { core, id } = seeded()
    appendItem(id, item('a'), core)
    appendItem(id, item('b'), core)

    expect(core.undoEntry()).toEqual({ ok: true, entries: 1 })
    expect(ids(core, id)).toEqual(['a'])
    expect(core.redoEntry()).toEqual({ ok: true, entries: 1 })
    expect(ids(core, id)).toEqual(['a', 'b'])
  })

  it('尾部不是自己那条时停住，不乱改别人的消息', () => {
    const { core, id, session } = seeded()
    appendItem(id, item('a'), core)
    // 绕开写入器直接改 store，模拟「世界与日志对不上」（外部改动 / 漏账）。
    session.store.setter(itemsAtom, () => [item('a'), item('intruder')])
    const cursorBefore = session.history.getState().cursor

    // fail-closed：宁可 undo 停住，也不要把 intruder 当成 'a' 弹掉。
    expect(core.undoEntry()).toEqual({ ok: false, refusal: 'nothing_to_apply', entries: 0 })
    expect(ids(core, id)).toEqual(['a', 'intruder'])
    expect(session.history.getState().cursor).toBe(cursorBefore)
  })
})

describe('按 id 打补丁的逆操作', () => {
  it('撤销把那一条换回旧内容，且不动别的条目', () => {
    const { core, id } = seeded()
    appendItem(id, item('a', '原文'), core)
    appendItem(id, item('b', '旁边这条'), core)
    updateItem(id, 'a', { pending: true }, core)

    expect(core.getSessionStore(id).store.getter(itemsAtom)[0]).toMatchObject({ id: 'a', pending: true })
    expect(core.undoEntry()).toEqual({ ok: true, entries: 1 })
    const items = core.getSessionStore(id).store.getter(itemsAtom)
    expect(items[0].pending).toBeUndefined()
    expect(items[1]).toMatchObject({ id: 'b' })
  })

  it('id 不存在时一条账都不记', () => {
    const { core, id, session } = seeded()
    appendItem(id, item('a'), core)
    const before = session.history.getState().entries.length

    updateItem(id, '不存在', { pending: true }, core)

    // 原先的 prev.map(...) 即使零匹配也会产生新数组，于是记下一条 before/after 深度相等的账
    // （Object.is 为假，commit 滤不掉）—— 白占一步 undo，整值记账下还是整个数组那么大。
    expect(session.history.getState().entries.length).toBe(before)
  })
})
