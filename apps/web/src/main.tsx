import React from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from '@einfach/react'
import {
  activeSessionMetaAtom,
  configureCommands,
  newSession,
  defaultCore,
  configureDefaultDelegation,
  configureDefaultProjectSkillsProvider,
  configureDefaultSkillsRegistry,
} from '@web-agent/core'
import { registerStandardTools } from '@web-agent/tools'
import { buildProjectSkillsProvider, builtInSkillsRegistry } from '@web-agent/tools-skills'
import { hydrateMcpSettings } from './mcp/commands'
import { initializeMcpSettings } from './mcp/initialize'
import { hydratePluginSettings } from './plugins/commands'
import { initializePluginSettings } from './plugins/initialize'
import { createDefaultPlanRuntime } from '@web-agent/tools-planning'
import { createDelegationAssembly } from '@web-agent/subagents'
import {
  configureObservability,
  configureTraceLogReader as configureTraceLogReaderFactory,
} from '@web-agent/core/observability'
import { createIndexedDbLogDriver, createIndexedDbLogReader } from '@web-agent/observability-idb'
import { isTauri } from '@tauri-apps/api/core'
import { AppShell } from './agentNew/ui/AppShell'
import { StartupCredentialGate } from './agentNew/ui/StartupCredentialGate'
import { WebTimelineRendererRegistryProvider } from './agentNew/ui/WebTimelineRendererRegistryProvider'
import { WindowScrollDemo } from './demos/WindowScrollDemo'
import {
  configureModelCredentialHost,
  hydrateAppSettings,
} from './settings/commands'
import {
  createTauriModelCredentialHost,
  createUnavailableModelCredentialHost,
  MODEL_CREDENTIALS,
} from './settings/modelCredentialHost'
import {
  resolveStartupCredentialTarget,
  type StartupCredentialTargetResolution,
} from './settings/startupCredentialTarget'
import { createTauriModelFetch } from './modelTransport/tauriModelTransport'
import { createDevPreviewModelFetch } from './modelTransport/devPreviewModelTransport'
import { createUnavailableModelFetch } from './modelTransport/unavailableModelTransport'
import { prepareProviderUserInput } from './modelInput/prepareProviderUserInput'
import { disposeProviderUserContent } from './modelInput/disposeProviderUserContent'
import {
  reportReactCommit,
  startUiPerformanceDiagnostics,
} from './performanceDiagnostics'
import { createHostPersistenceDrivers } from './persistence/persistenceDrivers'
import {
  installBrowserRecoveryFlush,
  installDesktopRecoveryFlush,
} from './persistence/recoveryFlushLifecycle'
import './styles/global.css'
import './agentNew/ui/agentnew.css'

// 【登记反转 · TS1】defaultCore 造出来是无工具的——app 在此把标准工具装进它的 registry。
// core 不再硬编码工具，装什么由消费方（这里是 app）决定。
const core = defaultCore

registerStandardTools(core.tools)
configureDefaultSkillsRegistry(builtInSkillsRegistry)
configureDefaultProjectSkillsProvider(buildProjectSkillsProvider())
core.planRuntime = createDefaultPlanRuntime
configureDefaultDelegation(createDelegationAssembly)

// MCP 运行时必须在启动时装配，不能等用户点开设置弹窗才 mount（那样 autoConnect 形同虚设）。
// hydrate 会去连网络服务，故意不 await：让它在后台跑，不阻塞首屏渲染。
initializeMcpSettings()
void hydrateMcpSettings()

// 用户插件同理（P10）：桌面宿主在这里接上真实加载面并立即扫描一次，浏览器预览什么都不装，
// 保持 plugins/commands.ts 里那个如实回答"当前宿主不支持用户插件"的默认 service（蓝图 3.4）。
// 启动这一刻 workspace 还没 hydrate 回来，真正的扫描由 initialize 内的 root 订阅触发。
initializePluginSettings()
void hydratePluginSettings()

const tauriHost = isTauri()

// API Key 不进入前端配置：桌面端走原生代理，开发浏览器走本地 Node 中继，静态产物拒绝模型请求。
const desktopManagedCredentialMarker = 'desktop-managed-credential'
const providerFetch = tauriHost
  ? createTauriModelFetch()
  : import.meta.env.DEV
    ? createDevPreviewModelFetch()
    : createUnavailableModelFetch()
// 凭据表按 MODEL_CREDENTIALS 的 provider 生成：新增一家 provider 只改那张描述表，
// 不必在这里再列一遍厂商名（core 侧只按 vendor id 查表）。
const managedModelCredentials = Object.fromEntries(
  MODEL_CREDENTIALS.map(({ target }) => [target.provider, desktopManagedCredentialMarker]),
)
configureCommands({
  modelCredentials: managedModelCredentials,
  prepareUserInput: prepareProviderUserInput,
  disposeUserContent: (discarded, retained, context) => disposeProviderUserContent(discarded, retained, context, {
    apiKey: desktopManagedCredentialMarker,
    fetchImpl: providerFetch,
  }),
  fetchImpl: providerFetch,
})
configureModelCredentialHost(
  tauriHost ? createTauriModelCredentialHost() : createUnavailableModelCredentialHost(),
)

// 桌面关窗有 Tauri 的可 await 拦截；浏览器 pagehide 只能尽力排空已有写队列。
// 两边都只持有这个宿主自己的 Core instance，绝不触默认 facade 的持久化桥。
async function installRecoveryFlushLifecycle(): Promise<void> {
  if (tauriHost) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await installDesktopRecoveryFlush(core, getCurrentWindow())
    return
  }
  installBrowserRecoveryFlush(core)
}

function configureObservabilityDriver(): void {
  if (tauriHost) {
    void import('@web-agent/observability-sqlite')
      .then(({ createSqliteLogDriver }) => configureObservability({ driver: createSqliteLogDriver() }))
      .catch(() => {})
    return
  }
  configureObservability({ driver: createIndexedDbLogDriver() })
}

function configureTraceLogReaderHost(): void {
  if (tauriHost) {
    configureTraceLogReaderFactory(async () => {
      const { createSqliteLogReader } = await import('@web-agent/observability-sqlite')
      return createSqliteLogReader()
    })
    return
  }
  if (import.meta.env.DEV) {
    configureTraceLogReaderFactory(async () => {
      const { createDevSqliteLogReader } = await import('@web-agent/observability-sqlite')
      return createDevSqliteLogReader()
    })
    return
  }
  configureTraceLogReaderFactory(createIndexedDbLogReader)
}

function currentView(): string | null {
  return new URLSearchParams(window.location.search).get('view')
}

function renderRoot(children: React.ReactNode): void {
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Provider store={core.rootStore}>
        {children}
      </Provider>
    </React.StrictMode>,
  )
}

function renderApp(target: StartupCredentialTargetResolution): void {
  startUiPerformanceDiagnostics()
  renderRoot(
    <WebTimelineRendererRegistryProvider>
      <StartupCredentialGate enabled={tauriHost} target={target}>
        <React.Profiler id="AppShell" onRender={reportReactCommit}>
          <AppShell />
        </React.Profiler>
      </StartupCredentialGate>
    </WebTimelineRendererRegistryProvider>,
  )
}

function renderTraceViewer(): void {
  void import('./traceViewer/TraceViewer').then(({ TraceViewer }) => {
    renderRoot(<TraceViewer />)
  })
}

function renderWindowScrollDemo(): void {
  renderRoot(<WindowScrollDemo />)
}

// hydrate 先于种子/渲染（RF3 / codex P1）：盘上有会话就恢复，没有才种子一个空会话，避免首次空屏。
// 桌面端还必须等待凭据状态：AppShell 只在门禁确认目标 Key 已配置后才会挂载。
async function bootstrapApplication(): Promise<StartupCredentialTargetResolution> {
  const settingsHydration = hydrateAppSettings()
  try {
    core.persistence.configure({
      ...await createHostPersistenceDrivers(tauriHost),
      recoveryStore: (sessionId) => core.findSessionStore(sessionId)?.store,
    })
    await installRecoveryFlushLifecycle()
    configureObservabilityDriver()
    configureTraceLogReaderHost()
    const restored = await core.persistence.hydrate()
    if (!restored) newSession()
  } catch {
    newSession()
  }
  await settingsHydration
  return resolveStartupCredentialTarget(core.rootStore.getter(activeSessionMetaAtom)?.settings)
}

if (currentView() === 'window-scroll-demo') {
  renderWindowScrollDemo()
} else if (currentView() === 'traces') {
  configureObservabilityDriver()
  configureTraceLogReaderHost()
  renderTraceViewer()
} else {
  void bootstrapApplication().then(renderApp)
}
