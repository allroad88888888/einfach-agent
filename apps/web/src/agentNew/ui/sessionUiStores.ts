// 每会话一个 UI store —— 渲染态的家，与 core 的 agent store 平行。
// ---------------------------------------------------------------------------
// 为什么 UI store 也要**按会话分**：展开态、滑动窗口、输入框草稿、图片附件都是「这个会话的」。
// 做成一个全局 UI store 的话，切会话时消息窗口和草稿会串到另一个会话上。拆分前这些值靠着
// 「物理上落在会话 store 里」白拿了这层隔离，拆完必须自己维持。
//
// 缓存而不是随 React 生命周期建：`ActiveSessionProvider` 用 `key={id}` 切会话，组件整棵重挂。
// 不缓存的话切走再切回来，展开态和草稿全没了 —— 那是行为退化，不是拆分的目的。

import { createStore, type Store } from '@einfach/core'

const stores = new Map<string, Store>()

/** 取该会话的 UI store；未命中按需建，同 id 恒等同实例。 */
export function getSessionUiStore(sessionId: string): Store {
  const existing = stores.get(sessionId)
  if (existing) return existing
  const created = createStore()
  stores.set(sessionId, created)
  return created
}

/**
 * 会话被删除时丢掉它的渲染态。
 *
 * 不丢也不会出错（sessionId 不复用），但 Map 会随「开过多少个会话」单调增长；
 * 而且留着一份已删会话的草稿在内存里没有任何意义。
 */
export function dropSessionUiStore(sessionId: string): void {
  stores.delete(sessionId)
}

/** 仅测试用：清空缓存，隔离用例之间的渲染态。 */
export function resetSessionUiStores(): void {
  stores.clear()
}
