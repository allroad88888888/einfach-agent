// core 的两个 store 的 React 绑定 —— 界面与 agent 分住不同 store 的那条缝。
// ---------------------------------------------------------------------------
// 拆分后的三层是：
//   · **界面一个 store**（宿主拥有，全局唯一）—— einfach 的环境 `<Provider>` 就绑它；
//   · **core 的 root store**（跨会话登记表：工作区、会话元数据、当前会话 id）—— 走 useRootAtomValue；
//   · **core 的 per-session agent store**（items/run/plan…）—— 走 useAgentAtomValue，随会话切换。
//
// 为什么必须有这两条额外通路：`@einfach/react` 只有一个 `StoreContext`，`<Provider store>` 嵌套
// 只能**覆盖**不能并存。环境 store 一旦给了界面，core 的 atom 就没有环境可读了。
//
// 分工方向是刻意的：**环境 store 给界面**。这样漏改一处的后果是「core atom 从界面 store 读到
// 默认值」—— 消息列表当场空掉、会话列表空掉，dev 里一眼可见。反过来（环境给 core）漏改一处
// 是「新写的界面 atom 落进 core 的 store」，行为与拆分前一模一样、毫无症状，等于没拆。
// **响亮地失败优于静默地正确。**
//
// 只给读：两个 hook 都没有配套 setter。core 的状态写入必须收口在它自己的 writer / command 层
// （CLAUDE.md「状态与 UI 边界」），渲染层要改只能走 commands。需要写就去开一条命令，
// 别在这里加 `useAgentSetAtom`。

import { createContext, useContext, type ReactNode } from 'react'
import { useAtomValue } from '@einfach/react'
import type { Atom, Store } from '@einfach/core'

const AgentStoreContext = createContext<Store | undefined>(undefined)
const RootStoreContext = createContext<Store | undefined>(undefined)

/** 把 core 的跨会话 root store 绑给整棵应用树；它不随会话切换。 */
export function RootStoreProvider({ store, children }: { store: Store, children: ReactNode }) {
  return <RootStoreContext.Provider value={store}>{children}</RootStoreContext.Provider>
}

/** 把某个会话的 agent store 绑给子树；切会话时换实例。 */
export function AgentStoreProvider({ store, children }: { store: Store, children: ReactNode }) {
  return <AgentStoreContext.Provider value={store}>{children}</AgentStoreContext.Provider>
}

/**
 * 没有 Provider 就抛，**不静默回退到环境 store**。
 *
 * 回退才是危险的：读点会安静地落到界面 store 上、拿到 atom 默认值，组件照常渲染一份空状态。
 * 那正是这套绑定要消灭的失败模式，不能由它自己引入。
 */
function requireStore(store: Store | undefined, providerName: string): Store {
  if (!store) throw new Error(`该 hook 必须在 <${providerName}> 内使用`)
  return store
}

export function useRootStore(): Store {
  return requireStore(useContext(RootStoreContext), 'RootStoreProvider')
}

export function useAgentStore(): Store {
  return requireStore(useContext(AgentStoreContext), 'AgentStoreProvider')
}

/** 读一个 root atom（工作区 / 会话登记表）。写请走 commands。 */
export function useRootAtomValue<State>(atom: Atom<State>): State extends Promise<infer T> ? T : State {
  return useAtomValue(atom, { store: useRootStore() })
}

/** 读一个会话 atom。写请走 commands —— 本模块刻意不提供 setter，理由见文件头。 */
export function useAgentAtomValue<State>(atom: Atom<State>): State extends Promise<infer T> ? T : State {
  return useAtomValue(atom, { store: useAgentStore() })
}
