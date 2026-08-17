// 对话历史的增量记账 —— append / patch 两种 op 及其逆操作。
// ---------------------------------------------------------------------------
// ## 为什么 items 不能按整值记账
//
// 其余槽位都走 `writeSlot`：一条 op 存 `(before, after)` 两份**完整**槽位值。对 `run`、
// `plan` 这类有界的值没问题，对 `items` 是灾难 —— 它随对话无界增长，于是日志开销是
// `cap × 对话长度`，**二次**。
//
// 内存里看不出来：`[...prev, item]` 产生的新数组与旧数组**共享每个 item 的引用**，
// 100 条 entry 也就百来 KB。但 JSON / structuredClone **不认共享引用，会把每一个都展开成
// 完整副本** —— 实测一份 0.32 MB 的对话（40 轮、8KB 工具结果）落盘要 33 MB，100 倍。
// 落盘那一步才把这笔开销兑现，所以这不是「优化」，是接 `HistoryPersistPort` 的前置条件。
//
// 对齐 einfach-agent-rust 的红线 3/5：进日志的值必须可序列化、且**不随别的东西长大**。
// 那边有专门的测试断言 entry 的 `prev` < 1KB 且不随摘要正文变大；这里的对应物是
// sessionItemsLog.test.ts 里「entry 大小与对话长度无关」那条。
//
// ## 逆操作凭什么是对的
//
// 日志是严格的栈，undo 从游标往前逐条回放，所以「撤销一次 append」看到的一定是自己那条在尾部。
// 但**不靠这个假设**：两个 applier 都先校验目标位置真的是自己要动的那条（按 item id），
// 不匹配就返回 false —— einfach 会把整条 entry 已生效的部分逐条退回、游标不动（见其
// `applySequence`）。宁可 undo 停住，也不要静默改错一条消息。
//
// `setItems`（整体替换，仅计划阶段回退这类罕见路径用）仍按整值记账：它一次丢掉一整段，
// 逆操作本就需要那一整段，而它一个会话里只发生几次，不构成二次开销。

import type { Getter, History, Setter } from '@einfach/core'
import type { ConversationItem } from './core.type'
import { itemsAtom } from './sessionAtoms'
import { inTurnTransaction, type SlotWriteTarget } from './sessionSlotWrite'

/**
 * 两个增量 op 的 key。它们会进落盘记录，改名等于改格式。
 *
 * 与整值槽位的 `SESSION_SLOTS.items.key`（`'items'`）**并存**：同一个 atom 上挂三种还原方式，
 * 按 op.key 分派。恢复快照那一侧只认 `'items'`，不受这两个影响。
 */
export const ITEMS_APPEND_KEY = 'items:append'
export const ITEMS_PATCH_KEY = 'items:patch'

/** op.scope 存被动条目的 id —— 「还原哪一条」。 */
function scopeOf(op: { scope?: string }): string | undefined {
  return op.scope
}

/** 撤销一次追加 = 弹掉尾部那条；重做 = 再追加回去。 */
function appendApplier(
  getter: Getter,
  setter: Setter,
  op: { scope?: string; before: unknown; after: unknown },
  direction: 'undo' | 'redo',
): boolean {
  const items = getter(itemsAtom) as ConversationItem[]
  const id = scopeOf(op)
  const last = items[items.length - 1]
  if (direction === 'undo') {
    if (!last || last.id !== id) return false
    setter(itemsAtom, () => items.slice(0, -1))
    return true
  }
  // 尾部已经是这条 = 世界与日志对不上（重复 redo / 外部改动），停住而不是追加出一条重复的。
  if (last && last.id === id) return false
  setter(itemsAtom, () => [...items, op.after as ConversationItem])
  return true
}

/** 撤销/重做一次按 id 的条目替换：把那一条换成对应方向的那份。 */
function patchApplier(
  getter: Getter,
  setter: Setter,
  op: { scope?: string; before: unknown; after: unknown },
  direction: 'undo' | 'redo',
): boolean {
  const items = getter(itemsAtom) as ConversationItem[]
  const index = items.findIndex((item) => item.id === scopeOf(op))
  // 那条已经不在了（被更早的截断带走，而截断的 undo 还没回放到）→ 停住。
  if (index < 0) return false
  const next = items.slice()
  next[index] = (direction === 'undo' ? op.before : op.after) as ConversationItem
  setter(itemsAtom, () => next)
  return true
}

/** 把两种增量还原方式登记进一本日志。每本只登记一次（重复注册 einfach 会抛）。 */
export function registerItemsLogAppliers(history: History): void {
  history.registerApplier(ITEMS_APPEND_KEY, appendApplier)
  history.registerApplier(ITEMS_PATCH_KEY, patchApplier)
}

/**
 * 追加一条 item 并只记这一条的账。
 *
 * `before` 留 `undefined`：逆操作是「弹掉尾部」，不需要旧数组。`commit()` 会过滤
 * `Object.is(before, after)` 的 op，而 item 一定不是 `undefined`，所以不会被误滤。
 */
export function appendItemLogged(target: SlotWriteTarget, item: ConversationItem): void {
  const next = [...(target.store.getter(itemsAtom) as ConversationItem[]), item]
  inTurnTransaction(target, () => {
    target.store.setter(itemsAtom, () => next)
    target.history.record({ key: ITEMS_APPEND_KEY, scope: item.id, before: undefined, after: item })
  })
}

/**
 * 合并 patch 到匹配 id 的条目，只记这一条的账。
 *
 * 找不到该 id 时整体 no-op。原先的 `prev.map(...)` 即使一条都没匹配也会产生新数组，
 * 于是记下一条 before/after 深度相等的账（`Object.is` 为假，滤不掉）—— 白占一步 undo，
 * 而且在整值记账下那一步还是整个数组那么大。
 */
export function patchItemLogged(
  target: SlotWriteTarget,
  itemId: string,
  patch: Partial<ConversationItem>,
): void {
  const items = target.store.getter(itemsAtom) as ConversationItem[]
  const index = items.findIndex((item) => item.id === itemId)
  if (index < 0) return
  const before = items[index]
  const after = { ...before, ...patch }
  const next = items.slice()
  next[index] = after
  inTurnTransaction(target, () => {
    target.store.setter(itemsAtom, () => next)
    target.history.record({ key: ITEMS_PATCH_KEY, scope: itemId, before, after })
  })
}
