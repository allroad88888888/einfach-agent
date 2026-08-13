// 会话 atom 作用域 —— UI 绑定用的**受限只读通路**（盘点 E7 / 卡 S7b）。
// ---------------------------------------------------------------------------
// 背景：CLAUDE.md 的红线是「UI 只允许读取 atom、调用 commands，不持有 runtime store」。
//   但每会话一个独立 store 的架构下，UI 必须拿到那个 store 才能把会话作用域绑进
//   `<Provider store={…}>`，让子组件的 useAtomValue 读到该会话的 items/run/checkpoints。
//   在此之前 UI 是直接 import `state/sessionStore` 的 `getSessionStore` 来拿——那条通路同时
//   把 createSessionStore / dropSessionStore / resetSessionStores 一并递给了 UI，等于把
//   「会话 store 的生命周期」交到渲染层手里，这才是红线真正要挡的东西。
//
// 处置：不补 barrel、不放宽 state/sessionStore，而是在命令面开一个**只读、只做一件事**的口子：
//   给定会话 id，返回它的 atom 作用域，供 Provider 绑定。生命周期动作（建/丢/清）不在这里，
//   它们归 sessionCommands 的 newSession / removeSession —— UI 想换会话，只能走那两条命令。
//
// 为什么是函数而不是派生 atom：`<Provider>` 需要的是「此刻这个会话的 store 实例」。做成派生 atom
//   会把实例缓存进根 store，一旦某会话的 store 被丢弃重建（drop 后再 get），缓存值就是失效实例；
//   函数每次渲染现取，与改造前 `getSessionStore(id)` 的语义逐字一致，不引入新的失效窗口。

import type { Store } from '@einfach/core'
import type { CoreInstance } from '../core/coreInstance'

/** Builds the read-only session scope accessor consumed by UI providers. */
export function createSessionScopeCommands(core: CoreInstance) {
  // 简介：取某会话的 atom 作用域（einfach store），仅供 UI 绑定 <Provider>。
  // 详情：命中缓存即返回同一实例；未命中按需建（与会话内容 atom 的惰性初始化一致）。
  //   拿到的 store **只该用来读 atom**：写业务状态仍必须走 commands，
  //   否则 ghost guard / runId stale guard / 审计这些保护都会被绕过。
  function sessionAtomScope(sessionId: string): Store {
    return core.getSessionStore(sessionId).store
  }

  return { sessionAtomScope }
}
