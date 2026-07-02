// 会话状态写入器 —— 操作「当前会话的 store」，不收 store 参数（C7）。
// ---------------------------------------------------------------------------
// 两个 store 的分工（CHECKPOINT-STATE-PLAN §1 C3 / C7）：
//   · 会话是否存在的权威事实 = 顶层 rootStore 的 sessionsAtom（登记表）。
//     每个写入器先做 ghost guard：会话未登记 → no-op（防止给幽灵会话写内容）。
//   · 会话内容（items / run）写在「各自会话 store」里（getSessionStore(id).store），
//     用共享单例 atom key（itemsAtom / runAtom），值天然隔离，非分桶。
//   · 内容类写入收尾 touchSession：把该会话在 rootStore 里的 updatedAt 前进（R2 一致性）。
// 所有更新都是不可变的（替换数组/对象，C4），checkpoint 快照才有效。
// ⚠️ SessionMeta 无 status 字段 —— 运行状态归 runAtom，这里绝不写 session.status。

import { rootStore, sessionsAtom } from './rootStore'
import { getSessionStore } from './sessionStore'
import { itemsAtom, runAtom } from './sessionAtoms'
import type { ConversationItem, RunState, RunStatus } from './core.type'

// ghost guard：会话未在 rootStore 登记 → 后续写入应 no-op（C7）。
function sessionMissing(id: string): boolean {
  return !rootStore.getter(sessionsAtom)[id]
}

/**
 * 触碰会话：把 rootStore 登记表里该 SessionMeta.updatedAt 推到 Date.now()。
 * 不可变更新（替换整张表 + 替换该条 meta，C4）。会话未登记则 no-op。
 */
export function touchSession(id: string): void {
  if (sessionMissing(id)) {
    return
  }
  rootStore.setter(sessionsAtom, (prev) => {
    const meta = prev[id]
    if (!meta) {
      return prev
    }
    return { ...prev, [id]: { ...meta, updatedAt: Date.now() } }
  })
}

/**
 * 往该会话的对话历史尾部追加一条 item（不可变，产生新数组），收尾 touchSession。
 * 会话未登记则整体 no-op（不写内容、不 touch）。
 */
export function appendItem(id: string, item: ConversationItem): void {
  if (sessionMissing(id)) {
    return
  }
  getSessionStore(id).store.setter(itemsAtom, (prev) => [...prev, item])
  touchSession(id)
}

/**
 * 合并 patch 到匹配 itemId 的对话条目（不可变，map 出新数组 + 新条目），收尾 touchSession。
 * 会话未登记则 no-op；itemId 不存在时数组内容不变（仍会 touch）。
 */
export function updateItem(
  id: string,
  itemId: string,
  patch: Partial<ConversationItem>,
): void {
  if (sessionMissing(id)) {
    return
  }
  getSessionStore(id).store.setter(itemsAtom, (prev) =>
    prev.map((it) => (it.id === itemId ? { ...it, ...patch } : it)),
  )
  touchSession(id)
}

/**
 * 直接设置该会话的 run 状态（传 undefined 清空）。会话未登记则 no-op。
 */
export function setRun(id: string, run: RunState | undefined): void {
  if (sessionMissing(id)) {
    return
  }
  getSessionStore(id).store.setter(runAtom, run)
}

/**
 * 合并 patch 到该会话已有的 run（不可变，替换成新对象）。
 * 会话未登记、或当前无 run 时 no-op（不凭空创建 run）。
 */
export function patchRun(id: string, patch: Partial<RunState>): void {
  if (sessionMissing(id)) {
    return
  }
  const store = getSessionStore(id).store
  const cur = store.getter(runAtom)
  if (!cur) {
    return
  }
  store.setter(runAtom, { ...cur, ...patch })
}

/**
 * 只改 run 的 status（含 'stopped'），走 patchRun —— 无既有 run 时同样 no-op。
 */
export function setRunStatus(id: string, status: RunStatus): void {
  patchRun(id, { status })
}
