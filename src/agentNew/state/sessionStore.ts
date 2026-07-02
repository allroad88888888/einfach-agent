import { createStore, type Store } from '@einfach/core'

// 每个会话一个独立 store（C3）：工厂按需创建、Map 缓存。
// 会话内容 atom（items/run/checkpoints）用共享单例 key，值天然隔离在各自 store 里，
// 因此不需要 Record<sessionId, _> 分桶。本轮先不放 undo。

export interface SessionStore {
  id: string
  store: Store
}

// 模块级缓存：sessionId → 该会话独立的 store。
const sessionStores = new Map<string, SessionStore>()

/**
 * 为指定会话新建一个独立 store，写入 Map 缓存后返回。
 * 每次调用都建新 store —— 已存在同 id 会被覆盖（drop 后重建即走这条路）。
 */
export function createSessionStore(id: string): SessionStore {
  const sessionStore: SessionStore = { id, store: createStore() }
  sessionStores.set(id, sessionStore)
  return sessionStore
}

/**
 * 取该会话的 store：Map 命中则返回（幂等，同 id 同实例），
 * 未命中则按需创建一个新的。
 */
export function getSessionStore(id: string): SessionStore {
  const existing = sessionStores.get(id)
  if (existing) {
    return existing
  }
  return createSessionStore(id)
}

/** 关闭对话时丢弃其 store（从缓存移除，后续 get 会重建新实例）。 */
export function dropSessionStore(id: string): void {
  sessionStores.delete(id)
}

/** 仅测试用：清空全部缓存的 store，隔离用例之间的状态。 */
export function resetSessionStores(): void {
  sessionStores.clear()
}
