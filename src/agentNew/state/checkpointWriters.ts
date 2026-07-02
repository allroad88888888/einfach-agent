// checkpoint 写入 / 回退写入器（P6）—— 操作某会话自己的 store。
// ---------------------------------------------------------------------------
// 「截断式回退」语义（C2，git reset --hard）：
//   · commitCheckpoint —— 一轮对话收尾时，把当前 items 整体快照进 checkpointsAtom，
//     turnIndex = 快照进列表前的原长度；游标 currentTurnIndex 推进到「新长度 - 1」。
//   · jumpToCheckpoint  —— 跳回第 N 轮：恢复该轮 items，并**丢弃第 N 轮之后**的全部轮
//     （把 checkpointsAtom 截断到 N+1 长度），游标回到 N。不做分支保留。
// C4 不可变：commit 直接持有当时的 items 引用（后续对 itemsAtom 的更新都是整体替换、
//   不原地改动，所以旧快照恒定有效）；jump 用 slice / 直接赋值做整体替换。

import { rootStore, sessionsAtom } from './rootStore'
import { getSessionStore } from './sessionStore'
import { checkpointsAtom, currentTurnIndexAtom, itemsAtom } from './sessionAtoms'
import type { Checkpoint } from './checkpoint.type'

// ghost guard：会话未在 rootStore 登记 → 后续写入应 no-op（C7）。
// 直接查登记表；不经 getSessionStore（后者未命中会创建 store，会复活幽灵会话）。
function sessionMissing(id: string): boolean {
  return !rootStore.getter(sessionsAtom)[id]
}

/**
 * 提交一次 checkpoint：把当前会话 store 里的 items 快照追加到 checkpointsAtom。
 * turnIndex 取「追加前的列表长度」，游标推进到该 turnIndex。
 */
export function commitCheckpoint(id: string, label: string): void {
  if (sessionMissing(id)) return
  const store = getSessionStore(id).store
  const items = store.getter(itemsAtom)
  // 新快照的 turnIndex = 现有 checkpoint 数量（即它入列表后的下标）。
  const turnIndex = store.getter(checkpointsAtom).length
  const cp: Checkpoint = { turnIndex, label, createdAt: Date.now(), items }
  store.setter(checkpointsAtom, (prev) => [...prev, cp])
  store.setter(currentTurnIndexAtom, turnIndex)
}

/**
 * 跳回第 turnIndex 轮（截断式回退，C2）：
 * 恢复该轮的 items 快照，截断 checkpointsAtom 到 turnIndex+1，游标回到 turnIndex。
 * turnIndex 越界（对应 checkpoint 不存在）时直接 no-op，不改动任何 atom。
 */
export function jumpToCheckpoint(id: string, turnIndex: number): void {
  if (sessionMissing(id)) return
  const store = getSessionStore(id).store
  const list = store.getter(checkpointsAtom)
  const cp = list[turnIndex]
  // 越界（含负数）→ cp 为 undefined，直接 no-op，保持各 atom 原样。
  if (!cp) {
    return
  }
  // 恢复该轮的 items（整体替换，C4）。
  store.setter(itemsAtom, cp.items)
  // 截断：丢弃第 turnIndex 轮之后的全部快照（git reset --hard 语义）。
  store.setter(checkpointsAtom, list.slice(0, turnIndex + 1))
  store.setter(currentTurnIndexAtom, turnIndex)
}
