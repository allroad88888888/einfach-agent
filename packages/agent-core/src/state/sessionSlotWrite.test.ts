import { describe, expect, it } from 'vitest'
import { createHistory as bareHistory, createStore } from '@einfach/core'
import type { ConversationItem } from './core.type'
import { itemsAtom, planAtom } from './sessionAtoms'
import { composerDraftAtom } from './sessionTransientAtoms'
import { SESSION_SLOTS } from './sessionSlots'
import { createSessionHistory } from './sessionHistory'
import { writeSlot } from './sessionSlotWrite'

/** 与 createSessionStore 走同一个工厂 —— 登记那个循环只许存在一处。 */
function session() {
  const store = createStore()
  return { store, history: createSessionHistory(store) }
}

function item(id: string, content: string): ConversationItem {
  return { id, createdAt: 1, item: { role: 'user', content } }
}

describe('writeSlot', () => {
  it('records the write so undo restores the previous value', () => {
    const target = session()
    writeSlot(target, SESSION_SLOTS.composerDraft.key, composerDraftAtom, '写到一半')

    expect(target.store.getter(composerDraftAtom)).toBe('写到一半')
    expect(target.history.getState().entries).toHaveLength(1)

    expect(target.history.undo()).toBe(true)
    expect(target.store.getter(composerDraftAtom)).toBe('')
    expect(target.history.redo()).toBe(true)
    expect(target.store.getter(composerDraftAtom)).toBe('写到一半')
  })

  it('accepts an updater so an append stays expressed as an append', () => {
    const target = session()
    writeSlot(target, SESSION_SLOTS.items.key, itemsAtom, [item('a', '第一句')])
    writeSlot(target, SESSION_SLOTS.items.key, itemsAtom, (prev) => [...prev, item('b', '第二句')])

    expect(target.store.getter(itemsAtom).map((entry) => entry.id)).toEqual(['a', 'b'])
    target.history.undo()
    expect(target.store.getter(itemsAtom).map((entry) => entry.id)).toEqual(['a'])
  })

  it('collapses several writes wrapped by one transaction into a single undo step', () => {
    const target = session()
    // 命令层用一个 transaction 包住若干写入器时，用户按一次 undo 应当整组回滚，
    // 而不是一个写入器一步 —— 写入器自己不必知道它处在更大的事务里。
    target.history.transaction('一次命令', () => {
      writeSlot(target, SESSION_SLOTS.composerDraft.key, composerDraftAtom, '草稿')
      writeSlot(target, SESSION_SLOTS.items.key, itemsAtom, [item('a', '发出去了')])
    })

    expect(target.history.getState().entries).toHaveLength(1)
    expect(target.history.getState().entries[0]?.label).toBe('一次命令')

    target.history.undo()
    expect(target.store.getter(composerDraftAtom)).toBe('')
    expect(target.store.getter(itemsAtom)).toEqual([])
  })

  it('does not spend an undo step on a write that changes nothing', () => {
    const target = session()
    writeSlot(target, SESSION_SLOTS.composerDraft.key, composerDraftAtom, '同一个值')
    writeSlot(target, SESSION_SLOTS.composerDraft.key, composerDraftAtom, '同一个值')

    // 否则「设了个相同的值」也会占一步，用户按 undo 看不到任何变化。
    expect(target.history.getState().entries).toHaveLength(1)
  })

  it('fails closed when the key has no applier registered', () => {
    const store = createStore()
    const history = bareHistory(store)
    // 故意不登记任何 applier：record 找不到还原方式就该当场抛，而不是记一笔无法回放的账。
    expect(() => writeSlot({ store, history }, 'plan', planAtom, undefined))
      .toThrow(/plan/)
  })
})
