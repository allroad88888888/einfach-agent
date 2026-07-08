import React from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from '@einfach/react'
import { rootStore } from './agentNew/state/rootStore'
import { configureCommands, newSession } from './agentNew/runtime/commands'
import { configurePersistence } from './agentNew/runtime/persistenceBridge'
import { configureObservability } from './agentNew/observability/trace'
import { hydrate } from './agentNew/state/persistence/hydrate'
import { createIndexedDbHistoryDriver } from './agentNew/state/persistence/indexedDbDriver'
import { createIndexedDbLogDriver } from './agentNew/observability/indexedDbLogDriver'
import { createSessionsPersistence } from './agentNew/state/persistence/sessionsPersistence'
import { isTauri } from '@tauri-apps/api/core'
import { AppShell } from './agentNew/ui/AppShell'
import { TraceViewer } from './agentNew/observability/TraceViewer'
import './styles/global.css'
import './agentNew/ui/agentnew.css'

// 注入 model apiKey（命令层按会话 vendor 取对应 key）。没有 key 时 model 调用会降级为 error。
configureCommands({
  deepseekApiKey: import.meta.env.VITE_DEEPSEEK_API_KEY ?? '',
  glmApiKey: import.meta.env.VITE_GLM_API_KEY ?? '',
})

// 持久化 driver：桌面壳（Tauri）用 SQLite，浏览器用 IndexedDB（TaK1，上层逻辑不变）。
// hydrate（读回）与 configurePersistence（写盘钩子）必须用同一对实例。sqlite 实现**动态 import**
// —— 只在 Tauri 下加载，浏览器 bundle 不含它（代码分割 + 避免非 Tauri 环境引 plugin-sql）。
async function resolvePersistence() {
  if (isTauri()) {
    const { createSqlitePersistence } = await import('./agentNew/state/persistence/sqliteDriver')
    return createSqlitePersistence()
  }
  return {
    history: createIndexedDbHistoryDriver(),
    sessions: createSessionsPersistence(),
  }
}

function configureObservabilityDriver(): void {
  if (isTauri()) {
    void import('./agentNew/observability/sqliteLogDriver')
      .then(({ createSqliteLogDriver }) => configureObservability({ driver: createSqliteLogDriver() }))
      .catch(() => {})
    return
  }
  configureObservability({ driver: createIndexedDbLogDriver() })
}

function isTraceView(): boolean {
  return new URLSearchParams(window.location.search).get('view') === 'traces'
}

function renderRoot(children: React.ReactNode): void {
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Provider store={rootStore}>
        {children}
      </Provider>
    </React.StrictMode>,
  )
}

function renderApp(): void {
  renderRoot(<AppShell />)
}

function renderTraceViewer(): void {
  renderRoot(<TraceViewer />)
}

// hydrate 先于种子/渲染（RF3 / codex P1）：盘上有会话就恢复，没有才种子一个空会话，避免首次空屏。
// 容错（DK2）：hydrate 绝不 reject；driver 解析/动态 import 失败也兜底种一个会话，别空屏。finally 必渲染。
if (isTraceView()) {
  configureObservabilityDriver()
  renderTraceViewer()
} else {
  resolvePersistence()
    .then(({ history, sessions }) => {
      configurePersistence({ history, sessions })
      configureObservabilityDriver()
      return hydrate({ history, sessions })
    })
    .then((restored) => {
      if (!restored) newSession()
    })
    .catch(() => {
      newSession()
    })
    .finally(renderApp)
}
