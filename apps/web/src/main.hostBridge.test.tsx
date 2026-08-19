// H5：桌面宿主下 main.tsx 必须把命令桥登记进 core，且必须早于任何工具可能执行的时点。
// ---------------------------------------------------------------------------
// 为什么单独一个文件、不并进 main.test.tsx：那份跑在**浏览器预览**宿主下（jsdom 里 isTauri()
// 为 false），而 main.tsx 的顶层副作用一个模块只求值一次——同一个 worker 里没法既以浏览器身份
// 又以桌面身份 import 一次 './main'。两种宿主 = 两个文件，是 vitest 的模块语义决定的，不是重复。
//
// 本文件只回答三件事，别的（MCP 装配、插件面 unsupported 默认）在 main.test.tsx：
//   1. 桌面分支登记了桥（hasHostBridge() 为 true），且解析出来的就是 Tauri 的 invoke 本体；
//   2. 登记发生在装配序列**最前面**——后面每一步被调用的那一刻桥都已经在了；
//   3. 有桥之后，runtime='server' 的那一整类工具重新进入模型可见的工具清单（H1 之前的行为）。

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * 时序探针。做成 vi.hoisted 的可变盒子，是因为 vi.mock 的工厂被提升到所有 import 之前，
 * 工厂闭包里不能引用本文件顶层的 import 绑定（Vitest 会以「mock 工厂访问了未初始化变量」报错）。
 * `readBridge` 由用例在 import('./main') **之前**填好，工厂体真正执行时（= main.tsx 调到它时）
 * 才去读，所以拿到的是那一刻的真实答案而不是事后补的。
 */
const probe = vi.hoisted(() => ({
  readBridge: undefined as (() => boolean) | undefined,
  atMcpInit: undefined as boolean | undefined,
  atPluginInit: undefined as boolean | undefined,
  atPersistenceHydrate: undefined as boolean | undefined,
}))

// 被换掉的重依赖分两类，都不是本文件的被测对象：
// (a) 装配序列上的探针点——mcp / plugins 的 initialize，换成只记录「此刻有没有桥」的哑实现；
// (b) 桌面分支在 jsdom 里会真的去够宿主内部通道的东西——Tauri window、SQLite 持久化 driver。
//     不换掉它们，bootstrapApplication 会在 hydrate 之前就抛进 catch，探针 3 永远测不到。
vi.mock('./mcp/initialize', () => ({
  initializeMcpSettings: () => { probe.atMcpInit = probe.readBridge?.() },
}))
vi.mock('./mcp/commands', () => ({ hydrateMcpSettings: vi.fn(async () => undefined) }))
vi.mock('./plugins/initialize', () => ({
  initializePluginSettings: () => { probe.atPluginInit = probe.readBridge?.() },
}))
vi.mock('./plugins/commands', () => ({ hydratePluginSettings: vi.fn(async () => undefined) }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({}) }))
vi.mock('./persistence/persistenceDrivers', () => ({
  createHostPersistenceDrivers: vi.fn(async () => ({})),
}))
vi.mock('./persistence/recoveryFlushLifecycle', () => ({
  installBrowserRecoveryFlush: vi.fn(),
  installDesktopRecoveryFlush: vi.fn(async () => undefined),
}))
vi.mock('@web-agent/core/runtime/commands', () => ({
  configureCommands: vi.fn(),
  newSession: vi.fn(),
}))
vi.mock('@web-agent/core/observability/trace', () => ({ configureObservability: vi.fn() }))
vi.mock('./agentNew/ui/AppShell', () => ({ AppShell: () => null }))
vi.mock('./agentNew/ui/StartupCredentialGate', () => ({ StartupCredentialGate: () => null }))
vi.mock('./agentNew/ui/WebTimelineRendererRegistryProvider', () => ({
  WebTimelineRendererRegistryProvider: () => null,
}))
vi.mock('./settings/commands', () => ({
  configureModelCredentialHost: vi.fn(),
  hydrateAppSettings: vi.fn(async () => undefined),
}))
vi.mock('./settings/modelCredentialHost', () => ({
  MODEL_CREDENTIALS: [],
  createTauriModelCredentialHost: vi.fn(() => ({})),
  createUnavailableModelCredentialHost: vi.fn(() => ({})),
}))
vi.mock('./settings/startupCredentialTarget', () => ({
  resolveStartupCredentialTarget: vi.fn(() => ({ status: 'unavailable' })),
}))
vi.mock('./modelTransport/tauriModelTransport', () => ({
  createTauriModelFetch: vi.fn(() => vi.fn()),
}))
vi.mock('./modelTransport/devPreviewModelTransport', () => ({
  createDevPreviewModelFetch: vi.fn(() => vi.fn()),
}))
vi.mock('./modelTransport/unavailableModelTransport', () => ({
  createUnavailableModelFetch: vi.fn(() => vi.fn()),
}))
vi.mock('./modelInput/prepareProviderUserInput', () => ({ prepareProviderUserInput: vi.fn() }))
vi.mock('./modelInput/disposeProviderUserContent', () => ({ disposeProviderUserContent: vi.fn() }))
vi.mock('./performanceDiagnostics', () => ({
  reportReactCommit: vi.fn(),
  startUiPerformanceDiagnostics: vi.fn(),
}))

// 桌面身份就是这一个全局量（main.tsx 的 isTauri() 只读它）。descriptor 存原样、事后还原，
// 手法照抄 packages/agent-core 的 hostTauri.test.ts / index.smoke.test.ts。
const originalIsTauri = Object.getOwnPropertyDescriptor(globalThis, 'isTauri')

beforeAll(() => {
  Object.defineProperty(globalThis, 'isTauri', { value: true, configurable: true, writable: true })
})

afterAll(async () => {
  if (originalIsTauri) Object.defineProperty(globalThis, 'isTauri', originalIsTauri)
  else delete (globalThis as { isTauri?: boolean }).isTauri
  // hostBridge 的 loader 是模块级单例：本文件把它登记成了「有桥」，退出前推回去。
  const { configureHostInvoke } = await import('@web-agent/core/runtime/hostBridge')
  configureHostInvoke(undefined)
})

describe('main entry · 桌面宿主的命令桥登记（H5）', () => {
  it('登记了桥，解析出来的就是 Tauri 的 invoke，且每一步装配时桥都已经在', async () => {
    document.body.innerHTML = '<div id="root"></div>'

    const { hasHostBridge, loadHostInvoke } = await import('@web-agent/core/runtime/hostBridge')
    const { defaultCore } = await import('@web-agent/core')
    probe.readBridge = hasHostBridge

    // hydrate 是「恢复出来的会话可能带着未完成的 run」的那一刻，也就是工具真正可能执行的最早时点。
    const hydrate = vi.spyOn(defaultCore.persistence, 'hydrate').mockImplementation(async () => {
      probe.atPersistenceHydrate = hasHostBridge()
      return false
    })

    expect(hasHostBridge()).toBe(false)

    // 入口是异步的（B3：宿主解析先于一切装配），`import()` 只等模块体求值完，登记是否发生
    // 要等它导出的 started。这里**故意不用**真实的 resolveHost 之外的东西：桌面那一支
    // 只读 globalThis.isTauri（上面 beforeAll 设的），一次网络都不会发。
    const { started } = await import('./main')
    await started

    expect(hasHostBridge()).toBe(true)
    // 桥背后必须是真的 Tauri invoke，不是某个「登记上了但解析不出东西」的空壳。
    const { invoke } = await import('@tauri-apps/api/core')
    await expect(loadHostInvoke()).resolves.toBe(invoke)

    // 时序：这三处在 main.tsx 里依次排在登记之后，被调用的那一刻 hasHostBridge() 都必须已为真。
    // 前两处是同步装配（少了桥，插件的 workspace 文件系统通路会被 `??=` 永久缓存成 undefined），
    // 第三处是 bootstrapApplication 的异步续段。
    expect(probe.atMcpInit).toBe(true)
    expect(probe.atPluginInit).toBe(true)
    await vi.waitFor(() => { expect(hydrate).toHaveBeenCalledOnce() })
    expect(probe.atPersistenceHydrate).toBe(true)
  })

  it('有桥之后 runtime=server 的工具整类回到模型可见的清单里', async () => {
    const { defaultCore } = await import('@web-agent/core')
    const { hasHostBridge } = await import('@web-agent/core/runtime/hostBridge')
    const { buildToolManifestText } = await import('@web-agent/core/runtime/toolManifest')

    // 逐字复刻生产表达式：modelTurnPrefix.ts 就是拿 hasHostBridge() 当总闸喂给它。
    const manifest = buildToolManifestText(hasHostBridge(), { registry: defaultCore.tools })
    const serverTools = defaultCore.tools.list()
      .filter((tool) => tool.runtime === 'server')
      .map((tool) => tool.name)

    // 断言清单非空本身就是断言的一部分：registry 空掉时下面的 for 会全空转而静默通过。
    expect(serverTools.length).toBeGreaterThan(0)
    for (const name of serverTools) expect(manifest).toContain(`· ${name} [server]`)
  })
})
