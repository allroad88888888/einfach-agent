// 按 id 成列的槽位的增量记账 —— append / patch / remove 三种 op 及其逆操作。
// ---------------------------------------------------------------------------
// ## 为什么这类槽位不能按整值记账
//
// `writeSlot` 一条 op 存 `(before, after)` 两份**完整**槽位值。对 `run`、`plan` 这类有界的值没问题，
// 对「随会话增长、且条目自带载荷」的列表是灾难：日志开销变成 `cap × 列表累积长度`，**二次**。
//
// 内存里看不出来：`[...prev, item]` 产生的新数组与旧数组**共享每个条目的引用**，100 条 entry
// 也就百来 KB。但 JSON / structuredClone **不认共享引用，会把每一个都展开成完整副本** ——
// 实测 `items` 一份 0.32 MB 的对话（40 轮、8KB 工具结果）落盘要 33 MB，100 倍。
// 落盘那一步才把这笔开销兑现，所以这不是「优化」，是接 `HistoryPersistPort` 的前置条件。
//
// 对齐 einfach-agent-rust 的红线 3/5：进日志的值必须可序列化、且**不随别的东西长大**。
// 那边有专门的测试断言 entry 的 `prev` < 1KB 且不随摘要正文变大。
//
// ## 逆操作凭什么是对的
//
// 日志是严格的栈，undo 从游标往前逐条回放，所以「撤销一次 append」看到的一定是自己那条在尾部。
// 但**不靠这个假设**：每个 applier 都先校验目标位置真的是自己要动的那条（按 id），不匹配就返回
// false —— einfach 会把整条 entry 已生效的部分逐条退回、游标不动（见其 `applySequence`）。
// 宁可 undo 停住，也不要静默改错一条内容。
//
// 整值 applier 仍然由槽位表注册、继续保留：罕见的整体替换（如计划阶段回退截断 `items`）
// 一次丢掉一整段，逆操作本就需要那一整段，且一个会话里只发生几次，不构成二次开销。

import type { AtomEntity, Getter, History, Setter } from '@einfach/core'
import { inTurnTransaction, type SlotWriteTarget } from './sessionSlotWrite'

interface Op {
  readonly scope?: string
  readonly before: unknown
  readonly after: unknown
}

/** remove 的 before 载荷：逆操作要把条目放回**原来的位置**，所以下标必须一起记。 */
interface RemovedEntry<T> {
  index: number
  item: T
}

export interface ListSlotLog<T> {
  /** 把三种增量还原方式登记进一本日志。每本只登记一次（重复注册 einfach 会抛）。 */
  register(history: History): void
  append(target: SlotWriteTarget, item: T): void
  /** 找不到该 id 时整体 no-op（不写、不记账）。 */
  patch(target: SlotWriteTarget, id: string, patch: Partial<T>): void
  /** 找不到该 id 时整体 no-op。 */
  remove(target: SlotWriteTarget, id: string): void
}

/**
 * 为一个「按 id 成列」的槽位造一套增量记账。
 *
 * `key` 是槽位的逻辑名，三个 op key 由它派生（`<key>:append` 等）。它们会进落盘记录，
 * 改名等于改格式。与整值槽位的 key 并存：同一个 atom 上挂多种还原方式，按 op.key 分派。
 */
export function createListSlotLog<T>(input: {
  key: string
  atom: AtomEntity<T[]>
  idOf: (item: T) => string
}): ListSlotLog<T> {
  const { key, atom, idOf } = input
  const appendKey = `${key}:append`
  const patchKey = `${key}:patch`
  const removeKey = `${key}:remove`

  const read = (getter: Getter): T[] => getter(atom) as T[]

  /** 撤销一次追加 = 弹掉尾部那条；重做 = 再追加回去。 */
  function appendApplier(getter: Getter, setter: Setter, op: Op, direction: 'undo' | 'redo'): boolean {
    const items = read(getter)
    const last = items[items.length - 1]
    if (direction === 'undo') {
      if (!last || idOf(last) !== op.scope) return false
      setter(atom, () => items.slice(0, -1))
      return true
    }
    // 尾部已经是这条 = 世界与日志对不上（重复 redo / 外部改动），停住而不是追加出一条重复的。
    if (last && idOf(last) === op.scope) return false
    setter(atom, () => [...items, op.after as T])
    return true
  }

  /** 撤销/重做一次按 id 的条目替换：把那一条换成对应方向的那份。 */
  function patchApplier(getter: Getter, setter: Setter, op: Op, direction: 'undo' | 'redo'): boolean {
    const items = read(getter)
    const index = items.findIndex((item) => idOf(item) === op.scope)
    // 那条已经不在了（被更早的整体替换带走，而它的 undo 还没回放到）→ 停住。
    if (index < 0) return false
    const next = items.slice()
    next[index] = (direction === 'undo' ? op.before : op.after) as T
    setter(atom, () => next)
    return true
  }

  /** 撤销一次删除 = 按原下标插回去；重做 = 再按 id 删掉。 */
  function removeApplier(getter: Getter, setter: Setter, op: Op, direction: 'undo' | 'redo'): boolean {
    const items = read(getter)
    if (direction === 'undo') {
      const removed = op.before as RemovedEntry<T> | undefined
      if (!removed || typeof removed.index !== 'number') return false
      // 已经在了 = 世界与日志对不上，停住而不是插出一条重复的。
      if (items.some((item) => idOf(item) === op.scope)) return false
      const next = items.slice()
      next.splice(Math.min(removed.index, next.length), 0, removed.item)
      setter(atom, () => next)
      return true
    }
    const index = items.findIndex((item) => idOf(item) === op.scope)
    if (index < 0) return false
    setter(atom, () => items.filter((_, at) => at !== index))
    return true
  }

  return {
    register(history) {
      history.registerApplier(appendKey, appendApplier)
      history.registerApplier(patchKey, patchApplier)
      history.registerApplier(removeKey, removeApplier)
    },

    append(target, item) {
      const next = [...read(target.store.getter), item]
      inTurnTransaction(target, () => {
        target.store.setter(atom, () => next)
        // before 留 undefined：逆操作是「弹掉尾部」，不需要旧数组。条目一定不是 undefined，
        // 所以不会被 commit() 的 Object.is(before, after) 过滤掉。
        target.history.record({ key: appendKey, scope: idOf(item), before: undefined, after: item })
      })
    },

    patch(target, id, patch) {
      const items = read(target.store.getter)
      const index = items.findIndex((item) => idOf(item) === id)
      if (index < 0) return
      const before = items[index]!
      const after = { ...before, ...patch }
      const next = items.slice()
      next[index] = after
      inTurnTransaction(target, () => {
        target.store.setter(atom, () => next)
        target.history.record({ key: patchKey, scope: id, before, after })
      })
    },

    remove(target, id) {
      const items = read(target.store.getter)
      const index = items.findIndex((item) => idOf(item) === id)
      if (index < 0) return
      const removed: RemovedEntry<T> = { index, item: items[index]! }
      const next = items.filter((_, at) => at !== index)
      inTurnTransaction(target, () => {
        target.store.setter(atom, () => next)
        target.history.record({ key: removeKey, scope: id, before: removed, after: null })
      })
    },
  }
}
