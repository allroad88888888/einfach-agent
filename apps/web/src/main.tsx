import React from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from '@einfach/react'
import { RootStoreProvider } from '@web-agent/react-plugin'
import { uiStore } from './uiStore'
import {
  activeSessionMetaAtom,
  configureCommands,
  newSession,
  defaultCore,
  configureDefaultDelegation,
  configureDefaultProjectSkillsProvider,
  configureDefaultSkillsRegistry,
  configureHostInvoke,
  detectLocalPlatform,
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
// invoke 与 isTauri 来自同一个模块，而 isTauri 本来就是静态 import——多取一个导出不会让浏览器
// 产物多一个模块。下面那个 host bridge loader 因此刻意不写成 `import('@tauri-apps/api/core')`：
// 本文件已经静态引了同一个说明符，动态形式在这里换不来任何惰性（模块早在静态图里），只会给
// Rollup 那条既有的「dynamic import will not move module into another chunk」告警再添一个源头。
import { invoke, isTauri } from '@tauri-apps/api/core'
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

// 宿主分流的唯一事实源。提到装配序列最前面是因为下面的 configureHostInvoke 要用它；
// isTauri() 只读 globalThis.isTauri（纯全局量、零副作用、不加载任何模块），换个位置求值不花代价。
const tauriHost = isTauri()

registerStandardTools(core.tools)

// 【H5】桌面宿主在这里把命令桥交给 core，生产代码里全仓只有这一处登记（apps/cli 至今没有桥，
// 但它在 H1 之前也从来不满足 isTauriHost()——Node 里没有 globalThis.isTauri，行为未变）。
// core 侧的 13 个 runtime 模块
// （workspaceRead/Write/Patch/Delete/PathOperation/Rg/Git/Change/Task、shellCommand、
// projectSkillsBridge、userSkillsRoot、modelTurnPrefix）已经不再问「是不是 Tauri」，只问
// 「宿主登记过桥没有」（packages/agent-core/src/runtime/hostBridge.ts）。少了这一句，桌面端的
// 文件 / shell / Git / rg 工具会整类对模型不可见（modelTurnPrefix 的 hostHasLocalCapabilities
// 就是 hasHostBridge()），执行也一律早退——H 线前九张卡换判据时留下的正是这个缺口。
//
// 【为什么是这一行】它必须早于任何工具可能执行的时点，而本模块体到最后那句
// `void bootstrapApplication()` 之前全程同步，所以放在第一个装配块里就先于**所有**异步续段：
//   · 先于 bootstrapApplication() 里的 core.persistence.hydrate()——恢复出来的会话可能带着
//     未完成的 run，那是工具真正可能执行的第一个时点；
//   · 先于 initializePluginSettings() 那条 workspace root 订阅触发的插件扫描——
//     desktopProvider 的 resolveBridge() 会求值一次 buildProjectSkillsWorkspaceBridge() 并把
//     结果 `??=` 缓存住，那一刻没有桥的话，缓存下来的 undefined 会让插件面在整个进程生命周期里
//     都报「当前宿主没有 workspace 文件系统通路」，而且不会自愈；
//   · 也先于首屏渲染与 MCP 的 autoConnect。
// 登记本身是同步的（configureHostInvoke 收的是 loader 而不是已解析的 invoke，理由见
// hostBridge.ts 的 JSDoc），所以不存在「已登记但 hasHostBridge() 还答 false」的窗口。
//
// 【为什么不用 core 的 loadTauriInvoke()】它没有出现在 @web-agent/core 的公开面上，深导入
// `@web-agent/core/runtime/hostTauri` 会撞 check-boundaries 的 core 公开面白名单（S9）；
// 要不要把它放上公开面是 core 自己的决策，不该由本卡顺手做掉。装配层自己持有这个 loader 反而
// 更贴 H 线的方向：桥背后是什么由宿主说了算，core 不必认识 Tauri。
//
// 【为什么浏览器分支不登记】浏览器预览没有后端，登记等于骗 core 说有本机能力，模型会看到一堆
// 调用即失败的工具。给浏览器接本地 Node 后端是 B 线的事。
//
// 【S5】登记桥时必须一并声明宿主平台，两者是同一次登记的两半（hostBridge.ts 的
// HostBridgeRegistration）。桌面宿主可以用**本地探测**：webview 与原生跑在同一台机器上，
// `navigator.userAgent` 说什么，执行 shell 的就是那台机器。这条前提在**浏览器 → Node server**
// 上不成立（用户 macOS、服务端 Linux），B 线接 server 宿主时那个 platform 必须取自
// `GET /api/health` 的握手，不能照抄这一行。
if (tauriHost) {
  configureHostInvoke({ loader: () => Promise.resolve(invoke), platform: detectLocalPlatform() })
}

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

// 环境 store 给**界面**（一个，全局唯一）；core 的两个 store 各走自己的 Provider。
// 方向是刻意的，见 packages/agent-react/src/coreStoreBindings.tsx 的文件头：漏改一处时
// 「core atom 读到默认值」当场可见，反过来「界面 atom 落进 core 的 store」毫无症状。
// per-session 的 agent store 由 ActiveSessionProvider 在右栏按会话绑。
function renderRoot(children: React.ReactNode): void {
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Provider store={uiStore}>
        <RootStoreProvider store={core.rootStore}>
          {children}
        </RootStoreProvider>
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
      // 与 recoveryStore 同一条纪律：只交出已存在的会话，落盘绝不复活幽灵会话。
      historyFor: (sessionId) => core.findSessionStore(sessionId)?.history,
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
