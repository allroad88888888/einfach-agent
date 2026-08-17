// 会话状态写入器 —— 操作「当前会话的 store」，不收 store 参数（C7）。
// ---------------------------------------------------------------------------
// 两个 store 的分工：
//   · 会话是否存在的权威事实 = 顶层 rootStore 的 sessionsAtom（登记表）。
//     每个写入器先做 ghost guard：会话未登记 → no-op（防止给幽灵会话写内容）。
//   · 会话内容（items / run）写在「各自会话 store」里（getSessionStore(id).store），
//     用共享单例 atom key（itemsAtom / runAtom），值天然隔离，非分桶。
//   · 内容类写入收尾 touchSession：把该会话在 rootStore 里的 updatedAt 前进（R2 一致性）。
// 所有更新都是不可变的（替换数组/对象，C4）：恢复快照与将来的事务日志都靠这一点。
//
// 【store-scoped 变体】少数调用方只有一个 `Store`、拿不到 `CoreInstance`（`CoreCtx` 就是这样：
//   它按契约只给 store/root，不给 core）。它们需要 `*OnSession` 形式的写入器：同样的不可变写，
//   但**不做 ghost guard、不 touchSession** —— 那两件事需要 rootStore，由 (id, core) 变体负责。
//   接入 einfach 事务日志后，`createHistory(store)` 本身就是 per-store 的，这一族正是被
//   `transaction()` 包住的那一层，所以形状先按 store 对齐。
// ⚠️ SessionMeta 无 status 字段 —— 运行状态归 runAtom，这里绝不写 session.status。
//
// 【实例化 · 第 2 期穿线】每个导出的写入器都加了尾参 core（类型 CoreInstance，默认 defaultCore）：
//   函数体内一律经「传入的 core」读写 —— rootStore → core.rootStore，getSessionStore(id) →
//   core.getSessionStore(id)。默认值就是 defaultCore（= 穿线前的模块全局单例），所以【不传 core 的
//   调用点行为逐字不变】。内部调用本文件别的写入器（touchSession / patchRun）一律把收到的 core
//   原样带下去，不让它偷偷退回默认实例。

import { SESSION_SLOTS } from './sessionSlots'
import { appendItemLogged, patchItemLogged } from './sessionItemsLog'
import { writeSlot, type SlotWriteTarget } from './sessionSlotWrite'
import { sessionsAtom } from './rootStore'
import { contextCheckpointAtom, itemsAtom, runAtom } from './sessionAtoms'
import type { ContextCheckpoint } from './contextCheckpoint.type'
import type { ConversationItem, RunState, RunStatus } from './core.type'
import { defaultCore, type CoreInstance } from '../runtime/core/coreInstance'

// ghost guard：会话未在 core 的 rootStore 登记 → 后续写入应 no-op（C7）。
function sessionMissing(id: string, core: CoreInstance): boolean {
  return !core.rootStore.getter(sessionsAtom)[id]
}

/**
 * 触碰会话：把 rootStore 登记表里该 SessionMeta.updatedAt 推到 Date.now()。
 * 不可变更新（替换整张表 + 替换该条 meta，C4）。会话未登记则 no-op。
 * core 默认 defaultCore —— 不传时与穿线前的模块全局行为逐字一致。
 */
export function touchSession(id: string, core: CoreInstance = defaultCore): void {
  if (sessionMissing(id, core)) {
    return
  }
  core.rootStore.setter(sessionsAtom, (prev) => {
    const meta = prev[id]
    if (!meta) {
      return prev
    }
    return { ...prev, [id]: { ...meta, updatedAt: Date.now() } }
  })
}

/**
 * 往给定会话的对话历史尾部追加一条 item（不可变，产生新数组）。
 *
 * 不做 ghost guard、不 touchSession —— 调用方只有 store、够不到 rootStore。存在性由调用方
 * 自己的守卫覆盖（插件路径上是 `ctx.isCurrent()`，它同时查 ghost 与 stale run）。
 * 需要那两件事的调用方走 `appendItem(id, item, core)`。
 */
export function appendItemToSession(target: SlotWriteTarget, item: ConversationItem): void {
  // 走增量记账而不是 writeSlot：整值记账会把整条对话数组存进日志两遍，落盘时膨胀百倍
  // （理由与实测见 sessionItemsLog.ts）。
  appendItemLogged(target, item)
}

/**
 * 写入（或用 `undefined` 清空）该会话的上下文压缩摘要。
 *
 * 与 appendItemToSession 同族：不做 ghost guard / touchSession。
 * 摘要只影响请求投影，不替换 itemsAtom 里可审计的原始消息。
 */
export function setContextCheckpointOnSession(
  target: SlotWriteTarget,
  checkpoint: ContextCheckpoint | undefined,
): void {
  writeSlot(target, SESSION_SLOTS.contextCheckpoint.key, contextCheckpointAtom, checkpoint)
}

/**
 * 往该会话的对话历史尾部追加一条 item（不可变，产生新数组），收尾 touchSession。
 * 会话未登记则整体 no-op（不写内容、不 touch）。
 */
export function appendItem(id: string, item: ConversationItem, core: CoreInstance = defaultCore): void {
  if (sessionMissing(id, core)) {
    return
  }
  appendItemToSession(core.getSessionStore(id), item)
  touchSession(id, core)
}

/**
 * 合并 patch 到匹配 itemId 的对话条目（不可变，map 出新数组 + 新条目），收尾 touchSession。
 * 会话未登记则 no-op；itemId 不存在时数组内容不变（仍会 touch）。
 */
export function updateItem(
  id: string,
  itemId: string,
  patch: Partial<ConversationItem>,
  core: CoreInstance = defaultCore,
): void {
  if (sessionMissing(id, core)) {
    return
  }
  patchItemLogged(core.getSessionStore(id), itemId, patch)
  touchSession(id, core)
}

/**
 * 直接替换该会话的对话历史（不可变，调用方负责传入新数组），收尾 touchSession。
 * 会话未登记则 no-op。用于截断当前未完成轮这类命令层操作。
 */
export function setItems(id: string, items: ConversationItem[], core: CoreInstance = defaultCore): void {
  if (sessionMissing(id, core)) {
    return
  }
  writeSlot(core.getSessionStore(id), SESSION_SLOTS.items.key, itemsAtom, items)
  touchSession(id, core)
}

/**
 * 直接设置该会话的 run 状态（传 undefined 清空）。会话未登记则 no-op。
 */
export function setRun(id: string, run: RunState | undefined, core: CoreInstance = defaultCore): void {
  if (sessionMissing(id, core)) {
    return
  }
  writeSlot(core.getSessionStore(id), SESSION_SLOTS.run.key, runAtom, run, run?.turnId)
}

/**
 * 合并 patch 到该会话已有的 run（不可变，替换成新对象）。
 * 会话未登记、或当前无 run 时 no-op（不凭空创建 run）。
 */
export function patchRun(id: string, patch: Partial<RunState>, core: CoreInstance = defaultCore): void {
  if (sessionMissing(id, core)) {
    return
  }
  const session = core.getSessionStore(id)
  const store = session.store
  const cur = store.getter(runAtom)
  if (!cur) {
    return
  }
  writeSlot(session, SESSION_SLOTS.run.key, runAtom, { ...cur, ...patch })
}

/**
 * 只改 run 的 status（含 'stopped'），走 patchRun —— 无既有 run 时同样 no-op。
 */
export function setRunStatus(id: string, status: RunStatus, core: CoreInstance = defaultCore): void {
  patchRun(id, { status }, core)
}
