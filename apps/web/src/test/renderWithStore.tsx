import type { ReactElement, ReactNode } from 'react'
import { Provider } from '@einfach/react'
import { createStore, type Store } from '@einfach/core'
import { AgentStoreProvider, RootStoreProvider } from '@einfach-agent/react-plugin'
import { rootStore as coreRootStore } from '@einfach-agent/core'
import { render, type RenderOptions } from '@testing-library/react'
import { WebTimelineRendererRegistryProvider } from '../agentNew/ui/WebTimelineRendererRegistryProvider'
import { AppI18nProvider, appI18n, type AppLocale } from '../i18n'
import { messages as chineseMessages } from '../i18n/locales/zh-CN/messages.po'
import { hydrateLocalePreference } from '../i18n/localePreferenceAtom'

function activeLocale(): AppLocale {
  if (!appI18n.locale) {
    appI18n.loadAndActivate({ locale: 'zh-CN', messages: chineseMessages })
  }
  return appI18n.locale as AppLocale
}

/**
 * 按生产装配的三层 store 渲染组件（见 main.tsx 与 ActiveSessionProvider）：
 *
 * - `store` —— **界面 store**，einfach 的环境 `<Provider>`。设置面板、展开折叠、草稿、
 *   图片附件、滑动窗口都从这里读写。默认现开一个，用例之间天然隔离。
 * - `rootStore` —— core 的跨会话登记表（工作区、会话元数据、当前会话 id）。**默认就是 core 的
 *   那个单例**，因为用例习惯直接 `rootStore.setter(sessionsAtom, …)` 播种，而 setup.ts 的
 *   `resetRootStore()` 也是清它；换成新实例会让那两处对不上。
 * - `agentStore` —— 某个会话的 agent store（items/run/plan…）。默认现开一个。
 *
 * 三个默认都是**不同实例**，刻意不让任何两个退化成同一个：共用的话「组件从错的那一层读」
 * 在测试里恰好也能跑通，而生产里读到的是默认值 —— 那正是拆分要消灭的静默失败。
 */
export function renderWithStore(
  ui: ReactElement,
  options: RenderOptions & { store?: Store, rootStore?: Store, agentStore?: Store } = {},
) {
  const locale = activeLocale()
  const store = options.store ?? createStore()
  hydrateLocalePreference(store, { getItem: () => locale, setItem: () => undefined })
  const rootStore = options.rootStore ?? coreRootStore
  const agentStore = options.agentStore ?? createStore()
  const {
    store: _store, rootStore: _rootStore, agentStore: _agentStore, wrapper: _wrapper, ...renderOptions
  } = options

  // 走 RTL 的 wrapper 而不是把 ui 手工包一层：`rerender(next)` 渲染的是**裸的** next，
  // 手工包的那几层会在 rerender 时整个消失。以前看不出来 —— einfach 的 hook 在没有 Provider 时
  // 静默回退到默认 store，于是 rerender 之后组件读的其实是另一个 store，测试照样绿。
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <Provider store={store}>
        <AppI18nProvider>
          <RootStoreProvider store={rootStore}>
            <AgentStoreProvider store={agentStore}>
              <WebTimelineRendererRegistryProvider>{children}</WebTimelineRendererRegistryProvider>
            </AgentStoreProvider>
          </RootStoreProvider>
        </AppI18nProvider>
      </Provider>
    )
  }

  return { store, rootStore, agentStore, ...render(ui, { wrapper: Wrapper, ...renderOptions }) }
}
