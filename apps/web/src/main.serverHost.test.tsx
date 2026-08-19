// B3：server 宿主（浏览器 + 本机 Node 后端）下 main.tsx 的装配分流。
// ---------------------------------------------------------------------------
// 为什么又是单独一个文件：main.tsx 的入口副作用一个 worker 里只求值一次，一个文件只能扮演
// 一种宿主。三态 = 三个文件（tauri 在 main.hostBridge.test.tsx，static 在 main.test.tsx），
// 是 vitest 的模块语义决定的，不是重复。
//
// 本文件回答四件事：
//   1. 登记了桥，且桥背后是 HTTP invoke 本体（不是 Tauri 的 invoke，也不是空壳）；
//   2. 平台取自握手、**原样**传给 core，没有被装配层映射成三选一；
//   3. 桥先于 hydrate 到位（恢复出来的未完成 run 是工具可能执行的第一个时点）；
//   4. 有桥之后 runtime='server' 的工具整类进入模型清单，而**模型凭据仍不可用**——
//      server 版凭据宿主与模型代理是 M 线，本卡不许顺手接上。

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const probe = vi.hoisted(() => ({
  readBridge: undefined as (() => boolean) | undefined,
  atPersistenceHydrate: undefined as boolean | undefined,
}))

/**
 * 握手报回的平台。刻意取 `'unsupported'`（FreeBSD / AIX 这类）而不是 `'linux'`：
 * `detectLocalPlatform()` 的返回类型是 `ShellPlatform`，**永远产不出这个值**，所以下面那条
 * 「hostPlatform() 等于它」的断言在任何机器上都只能由握手值满足——换成 linux 的话，跑在 Linux
 * 上的 CI 里即使装配层偷偷用了本地探测，测试也照样绿。它同时钉住 S5 的第 4 条：原样传，
 * 不要自己映射成三值之一。
 */
const HANDSHAKE_PLATFORM = 'unsupported'

vi.mock('./host/resolveHost', () => ({
  resolveHost: vi.fn(async () => ({ kind: 'server', platform: HANDSHAKE_PLATFORM })),
}))
vi.mock('./mcp/initialize', () => ({ initializeMcpSettings: vi.fn() }))
vi.mock('./mcp/commands', () => ({ hydrateMcpSettings: vi.fn(async () => undefined) }))
vi.mock('./plugins/initialize', () => ({ initializePluginSettings: vi.fn() }))
vi.mock('./plugins/commands', () => ({ hydratePluginSettings: vi.fn(async () => undefined) }))
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
vi.mock('@web-agent/observability-idb', () => ({
  createIndexedDbLogDriver: vi.fn(() => ({})),
  createIndexedDbLogReader: vi.fn(() => ({})),
}))
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
  createTauriModelCredentialHost: vi.fn(() => ({ available: true })),
  createUnavailableModelCredentialHost: vi.fn(() => ({ available: false })),
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

// 本文件不碰 globalThis.isTauri（jsdom 下天然为 false），但仍确认一次：server 宿主这条路上
// 没有任何一步依赖它，宿主态完全由 resolveHost 说了算。
beforeAll(() => {
  expect((globalThis as { isTauri?: boolean }).isTauri).toBeUndefined()
})

afterAll(async () => {
  // 桥与平台是模块级单例（同一次登记的两半），退出前一并推回去。
  const { configureHostInvoke } = await import('@web-agent/core/runtime/hostBridge')
  configureHostInvoke(undefined)
})

describe('main entry · server 宿主的装配分流（B3）', () => {
  it('登记 HTTP 桥、原样带上握手平台，且桥先于 hydrate 到位', async () => {
    document.body.innerHTML = '<div id="root"></div>'

    const { hasHostBridge, loadHostInvoke } = await import('@web-agent/core/runtime/hostBridge')
    const { hostPlatform } = await import('@web-agent/core/runtime/hostPlatform')
    const { httpInvoke } = await import('./host/serverInvoke')
    const { defaultCore } = await import('@web-agent/core')
    probe.readBridge = hasHostBridge

    const hydrate = vi.spyOn(defaultCore.persistence, 'hydrate').mockImplementation(async () => {
      probe.atPersistenceHydrate = hasHostBridge()
      return false
    })

    expect(hasHostBridge()).toBe(false)

    const { started } = await import('./main')
    await started

    expect(hasHostBridge()).toBe(true)
    // 桥背后必须是 B2 交出的那个 HTTP invoke 本体。
    await expect(loadHostInvoke()).resolves.toBe(httpInvoke)
    // 平台原样落地：core 的唯一读出口答的就是握手值。
    expect(hostPlatform()).toBe(HANDSHAKE_PLATFORM)

    await vi.waitFor(() => { expect(hydrate).toHaveBeenCalledOnce() })
    expect(probe.atPersistenceHydrate).toBe(true)
  })

  it('本机工具整类可见，而模型凭据仍走 unavailable（M 线未落地）', async () => {
    const { defaultCore } = await import('@web-agent/core')
    const { hasHostBridge } = await import('@web-agent/core/runtime/hostBridge')
    const { buildToolManifestText } = await import('@web-agent/core/runtime/toolManifest')
    const {
      createTauriModelCredentialHost,
      createUnavailableModelCredentialHost,
    } = await import('./settings/modelCredentialHost')
    const { createTauriModelFetch } = await import('./modelTransport/tauriModelTransport')

    const manifest = buildToolManifestText(hasHostBridge(), { registry: defaultCore.tools })
    const serverTools = defaultCore.tools.list()
      .filter((tool) => tool.runtime === 'server')
      .map((tool) => tool.name)

    expect(serverTools.length).toBeGreaterThan(0)
    for (const name of serverTools) expect(manifest).toContain(`· ${name} [server]`)

    // 真实 Key 只由桌面原生层读：server 宿主既不接原生代理，也不接能写 Key 的凭据宿主。
    expect(createUnavailableModelCredentialHost).toHaveBeenCalled()
    expect(createTauriModelCredentialHost).not.toHaveBeenCalled()
    expect(createTauriModelFetch).not.toHaveBeenCalled()
  })
})
