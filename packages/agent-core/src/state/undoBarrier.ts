// 撤销屏障 —— 不可逆动作在账本上留下的「到此为止」。
// ---------------------------------------------------------------------------
// 事务日志能还原的只有**状态**。跨进程边界发出去的动作还原不了：本仓当前只有一处，
// 用户显式停止 run 时 `disposeUserContentAfterMutation` 会经宿主注入的 disposer 真的去删
// provider 侧的上传（哪个 provider 由 adapter 决定，core 不认厂商）。删完之后再撤销，就会把
// 排队消息恢复成指向已删除上传的坏引用 —— 状态回来了，它引用的东西没回来。
//
// 对齐 einfach-agent-rust 的做法：给日志装一个屏障位，越过它的 undo 直接 Blocked，而不是
// 让它「看起来成功了」。这也是那篇时空可组合性论文 §6.1 的分法 —— 获取（acquisition）可回退，
// 发射（emission）跨了边界，只能**withhold 或补偿**，不能假装可逆。
//
// 本仓在这两条之间的选择：
//   · 显式停止 = 用户主动接受释放 → 照旧释放，并在此立屏障。
//   · 撤销自身**永不释放**（withhold）：状态马上要回滚，本来就没有东西真的变成不可达。
//     代价是「已撤销但可重做」的那段内容会在会话生命周期里一直占着 provider 侧的上传，
//     直到会话被删除（那条路径会释放全部）。这是有界的、可解释的，比发出一个收不回来的删除好。

import type { History, HistoryStackState } from '@einfach/core'
import { undoBarrierTxIdAtom } from './sessionTransientAtoms'
import type { SlotWriteTarget } from './sessionSlotWrite'

/**
 * 在当前最新账目上立屏障：它及更早的都不再可撤销。
 *
 * 立在**最新**那条而不是它的下一条：不可逆动作往往伴随自己的状态写入（停止 run 会清空排队消息，
 * 那正是让上传变成不可达的那一步）。若只挡「更早的」，那一步自己就会被撤销回来，坏引用照样出现。
 *
 * 直接 setter 不记账：屏障不能进事务日志，否则撤一步就把自己的守卫撤掉了。
 */
export function markUndoBarrier(target: SlotWriteTarget): void {
  const { entries } = target.history.getState()
  const newest = entries[entries.length - 1]
  if (!newest) return
  target.store.setter(undoBarrierTxIdAtom, () => newest.txId)
}

/** 读回屏障（供落盘刷出）。 */
export function readUndoBarrier(target: SlotWriteTarget): string | undefined {
  return target.store.getter(undoBarrierTxIdAtom)
}

/** 铺回屏障（供随日志一起读回）。 */
export function restoreUndoBarrier(target: SlotWriteTarget, txId: string | undefined): void {
  target.store.setter(undoBarrierTxIdAtom, () => txId)
}

/**
 * 下一次 undo 是否会越过屏障。纯函数，供命令层判定与 UI 可用态派生共用。
 *
 * 屏障那条被 cap 逐出后返回 false：剩下的条目全都比它新，撤销它们不会越过屏障。
 */
export function undoCrossesBarrier(
  stack: HistoryStackState,
  barrierTxId: string | undefined,
): boolean {
  if (barrierTxId === undefined || stack.cursor === 0) return false
  const barrierIndex = stack.entries.findIndex((entry) => entry.txId === barrierTxId)
  if (barrierIndex < 0) return false
  return stack.cursor - 1 <= barrierIndex
}

/** 命令层用的便捷判定（读当前 store 的屏障）。 */
export function undoBlockedByBarrier(store: SlotWriteTarget['store'], history: History): boolean {
  return undoCrossesBarrier(history.getState(), store.getter(undoBarrierTxIdAtom))
}
