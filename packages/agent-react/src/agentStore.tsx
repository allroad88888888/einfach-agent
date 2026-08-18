// agent store 的 React 绑定 —— 会话状态与渲染态分住两个 store 的那条缝。
// ---------------------------------------------------------------------------
// 为什么要有第二条通路：`@einfach/react` 只有一个 `StoreContext`，`<Provider store>` 嵌套只能
// **覆盖**、不能并存。要让「会话状态」和「渲染态」同时可读，必须有一个走 einfach 的环境 store、
// 另一个走自己的 context。
//
// 分工是刻意这样定的：**环境 store 给 UI**，agent store 走本模块。这样漏改一处的后果是
// 「core atom 从 UI store 读到默认值」—— 消息列表当场空掉，dev 里一眼可见。反过来（环境 store
// 给 agent）漏改一处的后果是「新写的 UI atom 落进 agent store」，行为与拆分前一模一样、
// 毫无症状，只有门禁能发现。**响亮地失败优于静默地正确。**
//
// 只给读：`useAgentAtomValue` 没有配套的 setter hook，这是设计而非遗漏。会话 atom 的写入必须
// 收口在 core 的 writer / command 层（CLAUDE.md「状态与 UI 边界」），渲染层要改会话状态只能
// 走 commands。需要写的地方去 `runtime/commands/` 开一条命令，别在这里加 `useAgentSetAtom`。

import { createContext, useContext, type ReactNode } from 'react'
import { useAtomValue } from '@einfach/react'
import type { Atom, Store } from '@einfach/core'

const AgentStoreContext = createContext<Store | undefined>(undefined)

/** 把某个会话的 agent store 绑给子树；UI store 仍由 einfach 的 `<Provider>` 提供。 */
export function AgentStoreProvider({ store, children }: { store: Store, children: ReactNode }) {
  return <AgentStoreContext.Provider value={store}>{children}</AgentStoreContext.Provider>
}

/**
 * 取当前会话的 agent store。
 *
 * 没有 Provider 就抛，**不静默回退到 einfach 的环境 store**：回退会让读点安静地落到 UI store 上、
 * 拿到 atom 默认值，那正是本模块要防的静默失败。
 */
export function useAgentStore(): Store {
  const store = useContext(AgentStoreContext)
  if (!store) throw new Error('useAgentStore 必须在 <AgentStoreProvider> 内使用')
  return store
}

/** 读一个会话 atom。写请走 commands —— 本模块刻意不提供 setter，理由见文件头。 */
export function useAgentAtomValue<State>(atom: Atom<State>): State extends Promise<infer T> ? T : State {
  return useAtomValue(atom, { store: useAgentStore() })
}
