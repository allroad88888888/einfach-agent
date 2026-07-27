// checkpoint 写入 / 回退写入器（P6）—— 操作某会话自己的 store。
// ---------------------------------------------------------------------------
// 「截断式回退」语义（C2，git reset --hard）：
//   · commitCheckpoint —— 一轮对话收尾时，把当前 items 整体快照进 checkpointsAtom，
//     turnIndex = 快照进列表前的原长度；游标 currentTurnIndex 推进到「新长度 - 1」。
//   · jumpToCheckpoint  —— 跳回第 N 轮：恢复该轮 items，并**丢弃第 N 轮之后**的全部轮
//     （把 checkpointsAtom 截断到 N+1 长度），游标回到 N。不做分支保留。
//   · rewindBeforeCheckpoint —— 撤回第 N 轮：恢复到该轮最后一条用户消息之前，并丢弃
//     第 N 轮及之后的 checkpoint；用于「回退并编辑」而不是恢复该轮结束快照。
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
import { checkpointsAtom, currentTurnIndexAtom, itemsAtom, planAtom } from './sessionAtoms'
import type { Checkpoint, RunRecoverySnapshot } from './checkpoint.type'
import { defaultCore, type CoreInstance } from '../runtime/core/coreInstance'
import type { PlanSnapshot } from '../planning/types'
import { persistSessions } from '../runtime/persistenceBridge'

// ghost guard：会话未在 core.rootStore 登记 → 后续写入应 no-op（C7）。
// 直接查登记表；不经 core.getSessionStore（后者未命中会创建 store，会复活幽灵会话）。
function sessionMissing(id: string, core: CoreInstance): boolean {
  return !core.rootStore.getter(sessionsAtom)[id]
}

// checkpoint 恢复必须同时更新 planAtom 和 SessionMeta.plan：前者驱动当前 UI，后者负责刷新后 hydrate。
function restorePlan(
  id: string,
  plan: PlanSnapshot | undefined,
  core: CoreInstance,
): void {
  core.getSessionStore(id).store.setter(planAtom, plan)
  core.rootStore.setter(sessionsAtom, (previous) => {
    const session = previous[id]
    if (!session) return previous
    return {
      ...previous,
      [id]: { ...session, plan, updatedAt: Date.now() },
    }
  })
  // persistenceBridge 绑定的是 defaultCore 的 rootStore；隔离 core 不写入默认实例的持久化层。
  if (core === defaultCore) persistSessions()
}

/**
 * 提交一次 checkpoint：把当前会话 store 里的 items 快照追加到 checkpointsAtom。
 * turnIndex 取「追加前的列表长度」，游标推进到该 turnIndex。
 * core 默认 defaultCore：不传时与旧版模块全局逐字等价；传入独立 core 则只读写该实例的 store。
 */
export function commitCheckpoint(
  id: string,
  label: string,
  core: CoreInstance = defaultCore,
  recovery?: RunRecoverySnapshot,
): void {
  if (sessionMissing(id, core)) return
  const store = core.getSessionStore(id).store
  const items = store.getter(itemsAtom)
  const plan = store.getter(planAtom)
  // 新快照的 turnIndex = 现有 checkpoint 数量（即它入列表后的下标）。
  const turnIndex = store.getter(checkpointsAtom).length
  const cp: Checkpoint = { turnIndex, label, createdAt: Date.now(), items, plan, recovery }
  store.setter(checkpointsAtom, (prev) => [...prev, cp])
  store.setter(currentTurnIndexAtom, turnIndex)
}

/**
 * 覆盖一个已存在 checkpoint 的 items 快照。
 * 用于长任务执行中的增量落盘；只更新同一轮，不允许越界追加。
 */
export function updateCheckpoint(
  id: string,
  turnIndex: number,
  label: string,
  core: CoreInstance = defaultCore,
  recovery?: RunRecoverySnapshot,
): void {
  if (sessionMissing(id, core)) return
  const store = core.getSessionStore(id).store
  const list = store.getter(checkpointsAtom)
  const previous = list[turnIndex]
  if (!previous) return
  const checkpoint: Checkpoint = {
    turnIndex,
    label,
    createdAt: previous.createdAt,
    items: store.getter(itemsAtom),
    plan: store.getter(planAtom),
    recovery,
  }
  store.setter(checkpointsAtom, list.map((item, index) => (index === turnIndex ? checkpoint : item)))
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
  restorePlan(id, cp.plan, core)
  // 截断：丢弃第 turnIndex 轮之后的全部快照（git reset --hard 语义）。
  store.setter(checkpointsAtom, list.slice(0, turnIndex + 1))
  store.setter(currentTurnIndexAtom, turnIndex)
}

/**
 * 撤回第 turnIndex 轮：
 * 恢复到该 checkpoint 中最后一条用户消息之前，丢弃该轮及之后的全部 checkpoint，
 * 游标回到前一轮。首轮撤回后 checkpoints 为空、游标为 -1。
 * checkpoint 不存在或其中没有用户消息时整体 no-op。
 */
export function rewindBeforeCheckpoint(
  id: string,
  turnIndex: number,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) return
  const store = core.getSessionStore(id).store
  const list = store.getter(checkpointsAtom)
  const cp = list[turnIndex]
  if (!cp) return

  let userIndex = -1
  for (let index = cp.items.length - 1; index >= 0; index -= 1) {
    if (cp.items[index].item.role === 'user') {
      userIndex = index
      break
    }
  }
  if (userIndex < 0) return

  store.setter(itemsAtom, cp.items.slice(0, userIndex))
  // 撤回目标轮本身时，恢复的是“上一轮结束后”的计划；撤回首轮则回到无计划状态。
  restorePlan(id, list[turnIndex - 1]?.plan, core)
  store.setter(checkpointsAtom, list.slice(0, turnIndex))
  store.setter(currentTurnIndexAtom, turnIndex - 1)
}
