import React from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from '@einfach/react'
import { rootStore } from '@web-agent/core/state/rootStore'
import { toolRegistry } from '@web-agent/core/tools/registry'
import { registerStandardTools } from '@web-agent/tools'
import {
  createMcpClientManager,
  createMcpConnectorRouter,
  createStreamableHttpMcpConnector,
} from '@web-agent/tools-mcp'
import { configureCommands, newSession } from '@web-agent/core/runtime/commands'
import { configurePersistence } from '@web-agent/core/runtime/persistenceBridge'
import { configureObservability } from '@web-agent/core/observability/trace'
import { hydrate } from '@web-agent/core/state/persistence/hydrate'
import { createIndexedDbHistoryDriver } from '@web-agent/core/state/persistence/indexedDbDriver'
import { createIndexedDbLogDriver } from '@web-agent/core/observability/indexedDbLogDriver'
import { createSessionsPersistence } from '@web-agent/core/state/persistence/sessionsPersistence'
import { isTauri } from '@tauri-apps/api/core'
import { AppShell } from './agentNew/ui/AppShell'
import { TraceViewer } from '@web-agent/core/observability/TraceViewer'
import { WindowScrollDemo } from './demos/WindowScrollDemo'
import { configureMcpSettings } from './mcp/commands'
import { createTauriStdioMcpConnector } from './mcp/tauriStdioConnector'
import {
  configureAppSettingsEnvironment,
  hydrateAppSettings,
} from './settings/commands'
import {
  reportReactCommit,
  startUiPerformanceDiagnostics,
} from './performanceDiagnostics'
import './styles/global.css'
import './agentNew/ui/agentnew.css'

// 【登记反转 · TS1】defaultCore 造出来是无工具的——app 在此把标准工具装进它的 registry
// （= toolRegistry = defaultCore.tools）。core 不再硬编码工具，装什么由消费方（这里是 app）决定。
registerStandardTools(toolRegistry)

// MCP 连接由应用层装配：浏览器与桌面共用官方 Streamable HTTP，
// 只有 Tauri 宿主开放 stdio 子进程桥接。连接管理器负责动态注册/卸载远端工具。
const tauriHost = isTauri()
const mcpConnector = createMcpConnectorRouter({
  'streamable-http': createStreamableHttpMcpConnector(),
  ...(tauriHost ? { stdio: createTauriStdioMcpConnector() } : {}),
})
const mcpManager = createMcpClientManager({
  registry: toolRegistry,
  connector: mcpConnector,
})
configureMcpSettings({
  manager: mcpManager,
  capabilities: { stdio: tauriHost },
})

// 环境变量是模型密钥的兜底；设备设置中的 DeepSeek key 会在 hydrate 时覆盖它。
const environmentDeepSeekApiKey = import.meta.env.VITE_DEEPSEEK_API_KEY ?? ''
configureCommands({
  deepseekApiKey: environmentDeepSeekApiKey,
  glmApiKey: import.meta.env.VITE_GLM_API_KEY ?? '',
})
configureAppSettingsEnvironment({ deepseekApiKey: environmentDeepSeekApiKey })
// 在首次渲染/新会话之前同步恢复全局设置，避免首个请求读到过期的运行时配置。
hydrateAppSettings()

// 持久化 driver：桌面壳（Tauri）用 SQLite，浏览器用 IndexedDB（TaK1，上层逻辑不变）。
// hydrate（读回）与 configurePersistence（写盘钩子）必须用同一对实例。sqlite 实现**动态 import**
// —— 只在 Tauri 下加载，浏览器 bundle 不含它（代码分割 + 避免非 Tauri 环境引 plugin-sql）。
async function resolvePersistence() {
  if (tauriHost) {
    const { createSqlitePersistence } = await import('@web-agent/core/state/persistence/sqliteDriver')
    return createSqlitePersistence()
  }
  return {
    history: createIndexedDbHistoryDriver(),
    sessions: createSessionsPersistence(),
  }
}

function configureObservabilityDriver(): void {
  if (tauriHost) {
    void import('@web-agent/core/observability/sqliteLogDriver')
      .then(({ createSqliteLogDriver }) => configureObservability({ driver: createSqliteLogDriver() }))
      .catch(() => {})
    return
  }
  configureObservability({ driver: createIndexedDbLogDriver() })
}

function currentView(): string | null {
  return new URLSearchParams(window.location.search).get('view')
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
  startUiPerformanceDiagnostics()
  renderRoot(
    <React.Profiler id="AppShell" onRender={reportReactCommit}>
      <AppShell />
    </React.Profiler>,
  )
}

function renderTraceViewer(): void {
  renderRoot(<TraceViewer />)
}

function renderWindowScrollDemo(): void {
  renderRoot(<WindowScrollDemo />)
}

// hydrate 先于种子/渲染（RF3 / codex P1）：盘上有会话就恢复，没有才种子一个空会话，避免首次空屏。
// 容错（DK2）：hydrate 绝不 reject；driver 解析/动态 import 失败也兜底种一个会话，别空屏。finally 必渲染。
if (currentView() === 'window-scroll-demo') {
  renderWindowScrollDemo()
} else if (currentView() === 'traces') {
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
