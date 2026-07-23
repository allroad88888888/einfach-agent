// checkpoint 写入 / 回退写入器（P6）—— 操作某会话自己的 store。
// ---------------------------------------------------------------------------
// 「截断式回退」语义（C2，git reset --hard）：
//   · commitCheckpoint —— 一轮对话收尾时，把当前 items 整体快照进 checkpointsAtom，
//     turnIndex = 快照进列表前的原长度；游标 currentTurnIndex 推进到「新长度 - 1」。
//   · jumpToCheckpoint  —— 跳回第 N 轮：恢复该轮 items，并**丢弃第 N 轮之后**的全部轮
//     （把 checkpointsAtom 截断到 N+1 长度），游标回到 N。不做分支保留。
// C4 不可变：commit 直接持有当时的 items 引用（后续对 itemsAtom 的更新都是整体替换、
//   不原地改动，所以旧快照恒定有效）；jump 用 slice / 直接赋值做整体替换。
//
// 【实例化 · 第 2 期穿线】两个导出的写入器都在既有参数之后加了默认参数 core（CoreInstance，
//   默认 defaultCore）：函数体内一律经 core.rootStore / core.getSessionStore(id) 读写，
//   不再摸模块全局 rootStore / getSessionStore。默认值就是 defaultCore——而 defaultCore.rootStore
//   正是 rootStore.ts 导出的那个 Store 引用、defaultCore.getSessionStore 也是 sessionStore.ts
//   导出函数背后委托的同一实现，所以不传 core 的调用点（现状全部调用点）行为逐字不变。
//   传入独立 core（如 createCoreInstance() 造的实例）时，读写只落在那个实例自己的 store，
//   与 defaultCore 互不污染（第 3 期隔离雏形）。

import { sessionsAtom } from './rootStore'
import { checkpointsAtom, currentTurnIndexAtom, itemsAtom } from './sessionAtoms'
import type { Checkpoint } from './checkpoint.type'
import { defaultCore, type CoreInstance } from '../runtime/core/coreInstance'

// ghost guard：会话未在 core.rootStore 登记 → 后续写入应 no-op（C7）。
// 直接查登记表；不经 core.getSessionStore（后者未命中会创建 store，会复活幽灵会话）。
function sessionMissing(id: string, core: CoreInstance): boolean {
  return !core.rootStore.getter(sessionsAtom)[id]
}

/**
 * 提交一次 checkpoint：把当前会话 store 里的 items 快照追加到 checkpointsAtom。
 * turnIndex 取「追加前的列表长度」，游标推进到该 turnIndex。
 * core 默认 defaultCore：不传时与旧版模块全局逐字等价；传入独立 core 则只读写该实例的 store。
 */
export function commitCheckpoint(id: string, label: string, core: CoreInstance = defaultCore): void {
  if (sessionMissing(id, core)) return
  const store = core.getSessionStore(id).store
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
 * core 默认 defaultCore，语义同 commitCheckpoint。
 */
export function jumpToCheckpoint(
  id: string,
  turnIndex: number,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) return
  const store = core.getSessionStore(id).store
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
