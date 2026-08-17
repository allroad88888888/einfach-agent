// 对话历史槽位的增量记账 —— 把通用列表机制绑到 items 上。
// ---------------------------------------------------------------------------
// 机制、理由与实测数字都在 listSlotLog.ts；本文件只负责「items 这个槽位怎么用它」。
//
// items 是最先撞上二次开销的槽位，也是最严重的那个：它随对话无界增长，条目还装着工具结果
// （8KB 的文件读取很常见）。整值记账实测 33 MB / 0.32 MB 对话；改增量后同场景 0.21 MB。
//
// 只用到 append 与 patch，没有 remove：items 的移除一律是「截断一整段」（计划阶段回退），
// 走整值 applier 更贴 —— 逆操作本就需要那一整段，且一个会话里只发生几次。

import type { ConversationItem } from './core.type'
import { itemsAtom } from './sessionAtoms'
import { createListSlotLog } from './listSlotLog'
import type { SlotWriteTarget } from './sessionSlotWrite'

const itemsLog = createListSlotLog<ConversationItem>({
  key: 'items',
  atom: itemsAtom,
  idOf: (item) => item.id,
})

/** 把 items 的增量还原方式登记进一本日志。由槽位表在建日志时调用。 */
export const registerItemsLogAppliers = itemsLog.register

/** 追加一条 item 并只记这一条的账。 */
export function appendItemLogged(target: SlotWriteTarget, item: ConversationItem): void {
  itemsLog.append(target, item)
}

/**
 * 合并 patch 到匹配 id 的条目，只记这一条的账。找不到该 id 时整体 no-op。
 *
 * 原先的 `prev.map(...)` 即使一条都没匹配也会产生新数组，于是记下一条 before/after 深度相等的账
 * （`Object.is` 为假，`commit()` 滤不掉）—— 白占一步 undo，而且在整值记账下那一步还是整个数组那么大。
 */
export function patchItemLogged(
  target: SlotWriteTarget,
  itemId: string,
  patch: Partial<ConversationItem>,
): void {
  itemsLog.patch(target, itemId, patch)
}
