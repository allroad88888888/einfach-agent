import { uiStore } from './uiStore'
import { describe, expect, it, vi } from 'vitest'

const defaultPersistenceFacade = vi.hoisted(() => ({
  configure: vi.fn(),
  hydrate: vi.fn(async () => false),
}))

// C1：main.tsx 必须在启动时装配 MCP 运行时（initializeMcpSettings + hydrateMcpSettings），
// 不能像之前那样只在 SettingsDialog 的 useEffect 里触发——那样用户不点开设置，
// autoConnect 的 MCP 服务永远连不上。本测试直接 import 真实的 './main' 入口，
// 全程不 import、不 mock 出任何 SettingsDialog/SettingsCenter，只把与 MCP 无关、
// 会触发网络/持久化/DOM 副作用的重依赖换成哑实现，从而证明：即使设置弹窗从未被
// mount 过，装配与 hydrate 依然会发生，且不阻塞首屏渲染（render 调用同步发出，
// hydrate 不被 await）。

// B3：宿主解析被钉死成 static（= 今天的浏览器预览/静态产物那一态）。两个理由：
//   · 生产实现会真的 `fetch('/api/health')`，jsdom 下那是一次**真实**网络请求打到
//     localhost——本机恰好有东西在听时结果还会变（B1 的文件头写明它刻意不碰全局 fetch，
//     依赖一律由调用方注入，正是为了不让测试依赖机器状态）；
//   · 本文件测的就是「没有本机能力的那一态」的装配结果，宿主态是前提不是被测对象。
vi.mock('./host/resolveHost', () => ({
  resolveHost: vi.fn(async () => ({ kind: 'static', reason: 'unreachable' })),
}))
vi.mock('@einfach-agent/core/runtime/commands', () => ({
  configureCommands: vi.fn(),
  newSession: vi.fn(),
}))
vi.mock('@einfach-agent/core/runtime/persistenceBridge', () => ({
  configurePersistence: defaultPersistenceFacade.configure,
  hydratePersistence: defaultPersistenceFacade.hydrate,
}))
vi.mock('@einfach-agent/core/observability/trace', () => ({
  configureObservability: vi.fn(),
}))
vi.mock('@einfach-agent/persistence-idb', () => ({
  createIndexedDbSessionsPersistence: vi.fn(() => ({})),
  createIndexedDbRecoveryDriver: vi.fn(() => ({})),
  createIndexedDbHistoryLogDriver: vi.fn(() => ({})),
}))
vi.mock('@einfach-agent/observability-idb', () => ({
  createIndexedDbLogDriver: vi.fn(() => ({})),
  createIndexedDbLogReader: vi.fn(() => ({})),
}))
// AppShell 是唯一会（间接、经由懒加载）触到 SettingsDialog 的组件——换成哑组件，
// 确保整条 import 链路里真的没有任何代码路径 mount 过 SettingsDialog/SettingsCenter。
vi.mock('./agentNew/ui/AppShell', () => ({
  AppShell: () => null,
}))
vi.mock('./agentNew/ui/StartupCredentialGate', () => ({
  StartupCredentialGate: () => null,
}))
vi.mock('./agentNew/ui/WebTimelineRendererRegistryProvider', () => ({
  WebTimelineRendererRegistryProvider: () => null,
}))
vi.mock('./settings/commands', () => ({
  configureModelCredentialHost: vi.fn(),
  configureModelEndpointHost: vi.fn(),
  hydrateAppSettings: vi.fn(async () => undefined),
  hydrateModelEndpoint: vi.fn(async () => undefined),
}))
vi.mock('./settings/modelCredentialHost', () => ({
  MODEL_CREDENTIALS: [],
  createUnavailableModelCredentialHost: vi.fn(() => ({})),
}))
vi.mock('./settings/startupCredentialTarget', () => ({
  resolveStartupCredentialTarget: vi.fn(() => ({ status: 'unavailable' })),
}))
vi.mock('./modelTransport/devPreviewModelTransport', () => ({
  createDevPreviewModelFetch: vi.fn(() => vi.fn()),
}))
vi.mock('./modelTransport/unavailableModelTransport', () => ({
  createUnavailableModelFetch: vi.fn(() => vi.fn()),
}))
vi.mock('./modelInput/prepareProviderUserInput', () => ({
  prepareProviderUserInput: vi.fn(),
}))
vi.mock('./modelInput/disposeProviderUserContent', () => ({
  disposeProviderUserContent: vi.fn(),
}))
vi.mock('./performanceDiagnostics', () => ({
  reportReactCommit: vi.fn(),
  startUiPerformanceDiagnostics: vi.fn(),
}))

describe('main entry: MCP 启动装配（C1）', () => {
  it('不 mount 设置弹窗/设置中心也会装配 MCP 并触发 hydrate', async () => {
    // main.tsx 顶层会调用 renderRoot -> createRoot(document.getElementById('root')!)。
    document.body.innerHTML = '<div id="root"></div>'

    const { isMcpSettingsConfigured } = await import('./mcp/commands')
    const { mcpHydrationAtom } = await import('./mcp/state')
    const { defaultCore } = await import('@einfach-agent/core')
    const configurePersistence = vi.spyOn(defaultCore.persistence, 'configure')
    const hydratePersistence = vi.spyOn(defaultCore.persistence, 'hydrate').mockResolvedValue(false)

    expect(isMcpSettingsConfigured()).toBe(false)
    expect(uiStore.getter(mcpHydrationAtom).status).toBe('idle')

    // 真正的入口文件：本测试从未 import 任何 SettingsDialog/SettingsCenter 模块。
    // 入口是异步的（宿主解析先于一切装配，B3），`import()` 只等模块体求值完，
    // 装配是否发生要等它导出的 started——不等的话下面每一条断言都跑在装配之前。
    const { started } = await import('./main')
    await started

    expect(configurePersistence).toHaveBeenCalledOnce()
    expect(hydratePersistence).toHaveBeenCalledOnce()
    expect(defaultPersistenceFacade.configure).not.toHaveBeenCalled()
    expect(defaultPersistenceFacade.hydrate).not.toHaveBeenCalled()
    const dependencies = configurePersistence.mock.calls[0]?.[0]
    const unknownSessionId = 'host-recovery-must-not-create-a-session'
    expect(defaultCore.findSessionStore(unknownSessionId)).toBeUndefined()
    expect(dependencies?.recoveryStore?.(unknownSessionId)).toBeUndefined()
    expect(defaultCore.findSessionStore(unknownSessionId)).toBeUndefined()

    // initializeMcpSettings() 是同步调用，import 完成时必须已经生效。
    expect(isMcpSettingsConfigured()).toBe(true)

    // hydrateMcpSettings() 故意不被 main.tsx await（不阻塞首屏渲染），
    // 但既然它已经被触发，等待一次微任务后应当离开初始的 idle 状态。
    await vi.waitFor(() => {
      expect(uiStore.getter(mcpHydrationAtom).status).not.toBe('idle')
    })
    expect(uiStore.getter(mcpHydrationAtom).status).toBe('ready')
  })

  // 依赖上一个用例先跑：main.tsx 顶层已经装配过一次。C2 把 SettingsDialog 里重复的
  // initializeMcpSettings() / hydrateMcpSettings() 调用删掉了（那两处调用曾是多余的——
  // 设置弹窗只该编辑配置，不该重复装配运行时），生产代码里现在只有 main.tsx 这一个调用点。
  // 但装配函数本身的幂等性仍然是需要保住的性质（防御性保证，避免任何未来调用点、
  // HMR 重复求值等场景把已经 ready 的运行时打回 loading/idle），所以这里直接重复调用
  // 这一对函数来验证：不会重新 configureMcpSettings()，也不会抛错。
  it('重复调用 initializeMcpSettings/hydrateMcpSettings 仍是幂等的，不会重新装配或重新 hydrate', async () => {
    const { initializeMcpSettings } = await import('./mcp/initialize')
    const { hydrateMcpSettings, isMcpSettingsConfigured } = await import('./mcp/commands')
    const { mcpHydrationAtom } = await import('./mcp/state')
    expect(isMcpSettingsConfigured()).toBe(true)
    expect(uiStore.getter(mcpHydrationAtom).status).toBe('ready')

    // 传的宿主态与本文件 `resolveHost` 的替身一致。这里**必须显式传**——`initializeMcpSettings`
    // 的签名在 C4 接线时从无参改成收 `ResolvedHost`（宿主态的唯一权威是 resolveHost，装配点不再
    // 自己探）。本条用例走的是幂等分支，运行时在 guard 处就 return、`host` 根本没被
    // 求值，所以漏传时 **vitest 照样全绿，只有 `tsc -b` 会红**。
    initializeMcpSettings({ kind: 'static', reason: 'unreachable' })
    void hydrateMcpSettings()

    // 幂等：guard 挡住了重新 configureMcpSettings，状态没有被打回 loading/idle。
    expect(uiStore.getter(mcpHydrationAtom).status).toBe('ready')
    await expect(hydrateMcpSettings()).resolves.toBeUndefined()
    expect(uiStore.getter(mcpHydrationAtom).status).toBe('ready')
  })

  // P10：插件运行时同样在 main.tsx 启动时装配（理由与 MCP 一致——插件注册的是 hook 与工具，
  // 等用户点开设置面板才装等于"不打开设置就没有插件"）。但本测试文件跑在 **static** 宿主下
  // （上面的 resolveHost 替身钉死了），它没有宿主命令桥，所以正确结果是**不装配**：面板照旧
  // 如实说"当前宿主不支持用户插件"，绝不为浏览器造一条读盘通路（蓝图 3.4）。
  // 有桥那一侧（server）在 plugins/initialize.test.ts。依赖第一个用例先 import 过 './main'。
  it('static 宿主：插件面保持 unsupported 默认，不接任何真实加载面（P10）', async () => {
    const { isPluginSettingsConfigured } = await import('./plugins/commands')
    const { pluginHydrationAtom, pluginSettingsCapabilitiesAtom } = await import('./plugins/state')
    expect(isPluginSettingsConfigured()).toBe(false)
    // main.tsx 同样不 await 这次 hydrate（不阻塞首屏），但它确实被触发了。
    await vi.waitFor(() => {
      expect(uiStore.getter(pluginHydrationAtom).status).toBe('ready')
    })
    expect(uiStore.getter(pluginSettingsCapabilitiesAtom)).toEqual({ supported: false })
  })

  // H5：同一条纪律的第三处落点——static 宿主**不登记宿主命令桥**。这边没有后端，登记等于骗 core
  // 说有本机能力，模型会拿到一堆调用即失败的文件/shell/Git/rg 工具。桥一旦缺席，
  // modelTurnPrefix 的总闸（hasHostBridge()）就把整类 runtime='server' 工具挡在清单外。
  // 有桥那一侧在 main.serverHost.test.tsx。依赖第一个用例先 import 过 './main'。
  it('static 宿主：不登记宿主命令桥，server 工具整类不进模型清单（H5）', async () => {
    const { hasHostBridge } = await import('@einfach-agent/core/runtime/hostBridge')
    const { buildToolManifestText } = await import('@einfach-agent/core/runtime/toolManifest')
    const { defaultCore } = await import('@einfach-agent/core')

    expect(hasHostBridge()).toBe(false)

    // 逐字复刻生产表达式：modelTurnPrefix.ts 就是拿 hasHostBridge() 当总闸喂给它。
    const manifest = buildToolManifestText(hasHostBridge(), { registry: defaultCore.tools })
    const serverTools = defaultCore.tools.list()
      .filter((tool) => tool.runtime === 'server')
      .map((tool) => tool.name)

    // 断言清单非空本身就是断言的一部分：registry 空掉时下面的 for 会全空转而静默通过。
    expect(serverTools.length).toBeGreaterThan(0)
    for (const name of serverTools) expect(manifest).not.toContain(name)
  })
})
