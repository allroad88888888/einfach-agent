import React from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from '@einfach/react'
import { RootStoreProvider } from '@einfach-agent/react-plugin'
import { uiStore } from './uiStore'
import { AppI18nProvider } from './i18n/AppI18nProvider'
import { initializeI18n } from './i18n/initializeI18n'
import {
  activeSessionMetaAtom,
  configureCommands,
  newSession,
  defaultCore,
  configureDefaultDelegation,
  configureDefaultProjectSkillsProvider,
  configureDefaultSkillsRegistry,
} from '@einfach-agent/core'
import { registerStandardTools } from '@einfach-agent/tools'
import { buildProjectSkillsProvider, builtInSkillsRegistry } from '@einfach-agent/tools-skills'
import { hydrateMcpSettings } from './mcp/commands'
import { initializeMcpSettings } from './mcp/initialize'
import { hydratePluginSettings } from './plugins/commands'
import { initializePluginSettings } from './plugins/initialize'
import { createDefaultPlanRuntime } from '@einfach-agent/tools-planning'
import { createDelegationAssembly } from '@einfach-agent/subagents'
// 宿主分流的四个装配面各住一个模块（B3）：桥、模型传输、凭据宿主、观测 driver。
// 本文件只按解析出的那一态把它们装起来，从不自己探宿主。
// 刷盘时机（A4）不在此列：两态都跑在浏览器里，`pagehide` 是两态唯一的通路，不存在第二支要分，
// 所以不经过 host/ 的装配面，直接调 persistence/recoveryFlushLifecycle 的 installBrowserRecoveryFlush。
import { resolveHost, type ResolvedHost } from './host/resolveHost'
import { registerHostCommandBridge } from './host/hostCommandBridge'
import { createHostModelCredentialHost } from './host/hostModelCredentialHost'
import { createHostModelEndpointHost } from './host/hostModelEndpointHost'
import { createHostModelConnectionProfileHost } from './host/hostModelConnectionProfileHost'
import { createHostModelFetch } from './host/hostModelTransport'
import { configureHostObservability } from './host/hostObservability'
import { AppShell } from './agentNew/ui/AppShell'
import { StartupCredentialGate } from './agentNew/ui/StartupCredentialGate'
import { WebTimelineRendererRegistryProvider } from './agentNew/ui/WebTimelineRendererRegistryProvider'
import { WindowScrollDemo } from './demos/WindowScrollDemo'
import {
  configureModelCredentialHost,
  configureModelEndpointHost,
  hydrateAppSettings,
  hydrateModelEndpoint,
} from './settings/commands'
import {
  configureModelConnectionProfileHost,
  hydrateModelConnectionProfiles,
} from './settings/modelConnectionProfileCommands'
import { MODEL_CREDENTIALS } from './settings/modelCredentialHost'
import {
  resolveStartupCredentialTarget,
  type StartupCredentialTargetResolution,
} from './settings/startupCredentialTarget'
import { prepareProviderUserInput } from './modelInput/prepareProviderUserInput'
import { disposeProviderUserContent } from './modelInput/disposeProviderUserContent'
import { createDeepSeekImageViewer } from './vision/deepseekImageViewer'
import {
  reportReactCommit,
  startUiPerformanceDiagnostics,
} from './performanceDiagnostics'
import { createHostPersistenceDrivers } from './persistence/persistenceDrivers'
import { installBrowserRecoveryFlush } from './persistence/recoveryFlushLifecycle'
import './styles/global.css'
import './agentNew/ui/agentnew.css'

// 【登记反转 · TS1】defaultCore 造出来是无工具的——app 在下面的装配序列里把标准工具装进它的
// registry。core 不再硬编码工具，装什么由消费方（这里是 app）决定。
const core = defaultCore

// API Key 不进入前端配置：模型请求由 host/hostModelTransport.ts 选出的那条受管传输发出，
// 前端只见这个标记，见不到真实 Key。
// 【为什么值本身不改】它是**协议字面量**：core 把它当 apiKey 一路带到受管传输那一层，改字符串
// 等于改一条跨模块约定，与本卡（删桌面端）无关。名字里的 desktop 是历史，含义是「宿主受管」。
const hostManagedCredentialMarker = 'desktop-managed-credential'

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
        <AppI18nProvider>
          <RootStoreProvider store={core.rootStore}>
            {children}
          </RootStoreProvider>
        </AppI18nProvider>
      </Provider>
    </React.StrictMode>,
  )
}

// 门禁开不开的判据是「这个宿主能不能管模型凭据」，不是宿主的品牌：门禁存在的全部理由
// 就是在渲染主工作区前确认受管凭据已配置，宿主管不了凭据时它没有可确认的东西。
function renderApp(
  target: StartupCredentialTargetResolution,
  credentialGateEnabled: boolean,
): void {
  startUiPerformanceDiagnostics()
  renderRoot(
    <WebTimelineRendererRegistryProvider>
      <StartupCredentialGate enabled={credentialGateEnabled} target={target}>
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
// 能管凭据的宿主还必须等待凭据状态：AppShell 只在门禁确认目标 Key 已配置后才会挂载。
async function bootstrapApplication(host: ResolvedHost): Promise<StartupCredentialTargetResolution> {
  const settingsHydration = hydrateAppSettings()
  const profileHydration = hydrateModelConnectionProfiles()
  try {
    core.persistence.configure({
      ...await createHostPersistenceDrivers(host),
      recoveryStore: (sessionId) => core.findSessionStore(sessionId)?.store,
      // 与 recoveryStore 同一条纪律：只交出已存在的会话，落盘绝不复活幽灵会话。
      historyFor: (sessionId) => core.findSessionStore(sessionId)?.history,
    })
    installBrowserRecoveryFlush(core)
    configureHostObservability(host)
    // A restored run may use connectionId immediately, and a first new session may use the saved
    // default. Both therefore wait until public profiles have populated the restricted registry.
    await Promise.all([settingsHydration, profileHydration])
    const restored = await core.persistence.hydrate()
    if (!restored) newSession()
  } catch {
    await Promise.allSettled([settingsHydration, profileHydration])
    newSession()
  }
  return resolveStartupCredentialTarget(core.rootStore.getter(activeSessionMetaAtom)?.settings)
}

// 装配序列。**顺序不是风格**：命令桥排第一（理由见 host/hostCommandBridge.ts 的文件头——
// 它必须先于插件扫描与 hydrate 出来的未完成 run），其余各步的先后各自注释在旁。
async function startApplication(): Promise<void> {
  const i18nReady = initializeI18n(uiStore)
  // 宿主解析必须在这里 await 掉，不能与装配并行发起：server 宿主要先握手才知道自己是 server、
  // 平台是什么（S5 把 platform 做成登记桥的必填字段），而桥要先于任何工具可能执行的时点到位。
  // 本文件此前那句「登记必须先于所有异步续段」只在同机宿主下成立——远端宿主的握手本身就是
  // 异步的，所以形状改成了「先 await 宿主解析，再 bootstrap」。
  const host = await resolveHost()
  registerHostCommandBridge(host)

  registerStandardTools(core.tools)
  configureDefaultSkillsRegistry(builtInSkillsRegistry)
  configureDefaultProjectSkillsProvider(buildProjectSkillsProvider())
  core.planRuntime = createDefaultPlanRuntime
  configureDefaultDelegation(createDelegationAssembly)

  // MCP 运行时必须在启动时装配，不能等用户点开设置弹窗才 mount（那样 autoConnect 形同虚设）。
  // hydrate 会去连网络服务，故意不 await：让它在后台跑，不阻塞首屏渲染。
  initializeMcpSettings(host)
  void hydrateMcpSettings()

  // 用户插件同理（P10）：有本机能力的宿主在这里接上真实加载面并立即扫描一次，static 宿主什么都
  // 不装，保持 plugins/commands.ts 里那个如实回答"当前宿主不支持用户插件"的默认 service（蓝图 3.4）。
  // 启动这一刻 workspace 还没 hydrate 回来，真正的扫描由 initialize 内的 root 订阅触发。
  // **必须传 host**（T1 吸收 B8）：此前这里是无参调用、由 initialize 自己再探一次宿主品牌，
  // 于是 server 宿主下用户插件整个特性静默缺席。判据只能有 resolveHost() 一处。
  initializePluginSettings(host)
  void hydratePluginSettings()

  const credentialHost = createHostModelCredentialHost(host)
  const connectionProfileHost = createHostModelConnectionProfileHost(host)
  const providerFetch = createHostModelFetch(host)
  // 凭据表按 MODEL_CREDENTIALS 的 provider 生成：新增一家 provider 只改那张描述表，
  // 不必在这里再列一遍厂商名（core 侧只按 vendor id 查表）。
  const managedModelCredentials = Object.fromEntries(
    MODEL_CREDENTIALS.map(({ target }) => [target.provider, hostManagedCredentialMarker]),
  )
  configureCommands({
    modelCredentials: managedModelCredentials,
    prepareUserInput: prepareProviderUserInput,
    disposeUserContent: (discarded, retained, context) => disposeProviderUserContent(discarded, retained, context, {
      apiKey: hostManagedCredentialMarker,
      fetchImpl: providerFetch,
    }),
    fetchImpl: providerFetch,
    viewImage: createDeepSeekImageViewer({
      apiKey: hostManagedCredentialMarker,
      fetchImpl: providerFetch,
    }),
  })
  configureModelCredentialHost(credentialHost)
  configureModelConnectionProfileHost(connectionProfileHost)
  // openai-compat 的接入点登记。**必须在这里装配**（与凭据宿主同一处、同一个宿主判据），
  // 而不是等设置弹窗打开才装：登记决定 adapter 有没有 baseUrl，而模型请求可能在用户点开设置
  // 之前就发生（hydrate 出来的未完成 run 会自己续上）。故意不 await——它是一次 HTTP 往返，
  // 没登记时 openai-compat 本来就发不出请求，让它在后台跑不阻塞首屏。
  configureModelEndpointHost(createHostModelEndpointHost(host))
  void hydrateModelEndpoint()

  const view = currentView()
  if (view === 'window-scroll-demo') {
    await i18nReady
    renderWindowScrollDemo()
    return
  }
  if (view === 'traces') {
    configureHostObservability(host)
    await i18nReady
    renderTraceViewer()
    return
  }
  const [target] = await Promise.all([bootstrapApplication(host), i18nReady])
  renderApp(target, credentialHost.available)
}

/**
 * 启动完成的信号。入口本身是异步的（宿主解析先于一切装配），而 `import('./main')` 只等模块体
 * 求值完——测试要观察装配结果就必须等这个 promise，否则断言会跑在装配之前。
 * 生产没有消费方：index.html 只 import 这个模块。
 */
export const started = startApplication()
