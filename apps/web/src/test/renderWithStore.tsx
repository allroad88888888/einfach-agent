import type { ReactElement, ReactNode } from 'react'
import { Provider } from '@einfach/react'
import { createStore, type Store } from '@einfach/core'
import { AgentStoreProvider } from '@web-agent/react-plugin'
import { render, type RenderOptions } from '@testing-library/react'
import { WebTimelineRendererRegistryProvider } from '../agentNew/ui/WebTimelineRendererRegistryProvider'

/**
 * 按生产装配的**两层 store** 渲染组件：einfach 的 `<Provider>` 给环境 store，
 * `<AgentStoreProvider>` 给 agent store（见 ActiveSessionProvider）。
 *
 * `store` 仍然是**环境 store**，语义与拆分前一字不差 —— 左栏那些组件（SessionList、
 * SettingsCenter、WorkspaceSidebar…）读的是 root/应用层 atom，它们既不在会话 Provider 下、
 * 也不该被这次拆分波及。会话内组件的渲染态（展开、草稿、滑动窗口）同样从这里读。
 *
 * 会话状态（items/run/plan…）走 `agentStore`，**默认是另一个实例**。刻意不让它退化成 `store`：
 * 共用一个 store 的话，「组件从错的那一层读」在测试里恰好也能跑通，而生产里读到的是默认值 ——
 * 那正是拆分要消灭的静默失败。
 */
export function renderWithStore(
  ui: ReactElement,
  options: RenderOptions & { store?: Store, agentStore?: Store } = {},
) {
  const store = options.store ?? createStore()
  const agentStore = options.agentStore ?? createStore()
  const { store: _store, agentStore: _agentStore, wrapper: _wrapper, ...renderOptions } = options

  // 走 RTL 的 wrapper 而不是把 ui 手工包一层：`rerender(next)` 渲染的是**裸的** next，
  // 手工包的那几层会在 rerender 时整个消失。以前看不出来 —— einfach 的 hook 在没有 Provider 时
  // 静默回退到默认 store，于是 rerender 之后组件读的其实是另一个 store，测试照样绿。
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <Provider store={store}>
        <AgentStoreProvider store={agentStore}>
          <WebTimelineRendererRegistryProvider>{children}</WebTimelineRendererRegistryProvider>
        </AgentStoreProvider>
      </Provider>
    )
  }

  return { store, agentStore, ...render(ui, { wrapper: Wrapper, ...renderOptions }) }
}
