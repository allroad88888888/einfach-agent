// 每个会话一个独立 store（C3）：工厂按需创建、Map 缓存。
// 会话内容 atom（items/run/checkpoints）用共享单例 key，值天然隔离在各自 store 里，
// 因此不需要 Record<sessionId, _> 分桶。本轮先不放 undo。
//
// 【实例化 · 第 1 期】本文件改成 defaultCore 的【视图】：per-session store 缓存 Map 从模块级
//   搬进了 CoreInstance（defaultCore），这里的四个函数只是【委托】给 defaultCore 的同名方法。
//   SessionStore 类型定义也随之迁到 coreInstance.ts（避免 coreInstance 反向 import 本文件成环），
//   这里 re-export 它，故 `import { type SessionStore } from './sessionStore'` 照旧有效。

import { defaultCore, type SessionStore } from '../runtime/core/coreInstance'

export type { SessionStore }

/**
 * 为指定会话新建一个独立 store，写入 Map 缓存后返回。
 * 每次调用都建新 store —— 已存在同 id 会被覆盖（drop 后重建即走这条路）。
 */
export function createSessionStore(id: string): SessionStore {
  return defaultCore.createSessionStore(id)
}

/**
 * 取该会话的 store：Map 命中则返回（幂等，同 id 同实例），
 * 未命中则按需创建一个新的。
 */
export function getSessionStore(id: string): SessionStore {
  return defaultCore.getSessionStore(id)
}

/** 关闭对话时丢弃其 store（从缓存移除，后续 get 会重建新实例）。 */
export function dropSessionStore(id: string): void {
  defaultCore.dropSessionStore(id)
}

/** 仅测试用：清空全部缓存的 store，隔离用例之间的状态。 */
export function resetSessionStores(): void {
  defaultCore.resetSessionStores()
}
