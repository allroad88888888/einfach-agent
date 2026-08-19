// 装配点选哪个存储后端：三态各走各的（B1 定的桌面 / 浏览器两态，C4 加上 server 那一态）。
//
//   · `tauri`  —— `mcp_config_read` / `mcp_config_write`（Tauri 命令）
//   · `server` —— 同一对命令名，但走 `POST /api/invoke/:command`（本机 Node 后端）
//   · `static` —— localStorage，没有任何本机能力
//
// 【为什么与 initialize.test.ts 分开】那边钉的是「缓存与占位一路走到模型面前」（B4/F4/F8/D3a），
// 全程只有一个宿主；这边钉的是「装配那一刻宿主是哪一态，读写就落到哪」，每个用例都要换一次
// 宿主。两者共用不了同一份 seed，也共用不了同一个已装配好的 service。
//
// 【宿主态从哪来】`initializeMcpSettings(host)` 收 `ResolvedHost`，**不自己探**——权威只有
// `resolveHost()` 一处（`main.tsx` 在 bootstrap 之前 await 掉它）。所以用例直接把想要的那一态
// 递进去，不再靠摆布 `isTauri()` 来间接表达「现在是什么宿主」。
//
// 【但 `isTauri()` 仍然要摆布一次】`createDesktopMcpConfigStorage()` 与
// `createDesktopToolNameCacheStorage()` 内部**各自还再探一次** `isTauri()`（见
// tauriMcpConfigStorage.ts / toolNameCacheStorage.ts）——装配点传下来的宿主态到不了它们那里。
// 所以 `freshHost()` 把这个替身与 `host.kind` 对齐；不对齐的话，测的是「两处结论打架」这种
// 生产上不会发生的状态。这处二次探测本身是既有事实，不在本次改动面内。
//
// 装配按 isMcpSettingsConfigured() 只生效一次，所以每个用例都先 vi.resetModules() 拿一套全新的
// 模块实例，再让它重新走一遍「按宿主态选 storage」。

import { describe, expect, it, vi } from 'vitest'
import type { ResolvedHost } from '../host/resolveHost'
import { MCP_SETTINGS_STORAGE_KEY } from './persistence'

// 用可控的替身，但保持与真实模块一致的默认表现：isTauri() 默认 false、invoke 不被意外调用。
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}))

// server 那一态的传输面。只替 `invokeServerCommand`——`ServerInvokeError` 等其余导出保留真身。
vi.mock('../host/serverInvoke', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../host/serverInvoke')>()
  return { ...actual, invokeServerCommand: vi.fn() }
})

const TAURI_HOST: ResolvedHost = { kind: 'tauri' }
const SERVER_HOST: ResolvedHost = { kind: 'server', platform: 'macos' }
const STATIC_HOST: ResolvedHost = { kind: 'static', reason: 'unreachable' }

/** 换一套全新模块实例，并把三个替身清干净（resetModules 不清替身的调用记录）。 */
async function freshHost(host: ResolvedHost) {
  vi.resetModules()
  const tauriCore = await import('@tauri-apps/api/core')
  const isTauriMock = vi.mocked(tauriCore.isTauri)
  const invokeMock = vi.mocked(tauriCore.invoke)
  const serverInvokeMock = vi.mocked((await import('../host/serverInvoke')).invokeServerCommand)
  isTauriMock.mockReset()
  invokeMock.mockReset()
  serverInvokeMock.mockReset()
  // 见文件头「但 isTauri() 仍然要摆布一次」。
  isTauriMock.mockReturnValue(host.kind === 'tauri')
  return { isTauriMock, invokeMock, serverInvokeMock }
}

describe('装配点按宿主态选存储后端', () => {
  it('Tauri 宿主下，服务配置的读写都经 mcp_config_read / mcp_config_write，不落 localStorage', async () => {
    const { invokeMock, serverInvokeMock } = await freshHost(TAURI_HOST)

    const remoteConfig = {
      id: 'remote-desktop',
      name: '桌面配置里的服务',
      transport: 'streamable-http' as const,
      url: 'https://desktop.example.test/mcp',
      autoConnect: false,
    }
    // 未识别的命令一律答 undefined 而不是抛错：这条链路上还并行挂着工具名缓存的
    // mcp_config_read/mcp_config_write（B5，走同一对 command），本用例只关心
    // 服务配置这一路，不想因为没模到另一路而让 hydrate 整体失败。
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'mcp_config_read') return { servers: [remoteConfig], toolNameCache: {} }
      return undefined
    })

    window.localStorage.clear()

    const { initializeMcpSettings: initializeFresh } = await import('./initialize')
    const { hydrateMcpSettings: hydrateFresh, removeMcpServer: removeFresh } =
      await import('./commands')

    initializeFresh(TAURI_HOST)
    await hydrateFresh()

    expect(invokeMock).toHaveBeenCalledWith('mcp_config_read')
    // 装配读到的服务确实来自 mcp_config_read，不是 localStorage 里的旧数据。
    expect(window.localStorage.getItem(MCP_SETTINGS_STORAGE_KEY)).toBeNull()
    // 桌面态一次都不该碰 HTTP 那条路。
    expect(serverInvokeMock).not.toHaveBeenCalled()

    await removeFresh('remote-desktop')

    const writeCalls = invokeMock.mock.calls.filter(([command]) => command === 'mcp_config_write')
    expect(writeCalls).toContainEqual(['mcp_config_write', { patch: { servers: [] } }])
    // 全程没有一次写落到浏览器存储。
    expect(window.localStorage.getItem(MCP_SETTINGS_STORAGE_KEY)).toBeNull()
  })

  it('server 宿主下，服务配置经 POST /api/invoke/mcp_config_*，既不落 localStorage 也不碰 Tauri', async () => {
    const { invokeMock, serverInvokeMock } = await freshHost(SERVER_HOST)

    const remoteConfig = {
      id: 'remote-server',
      name: '本机后端配置里的服务',
      transport: 'streamable-http' as const,
      url: 'https://server.example.test/mcp',
      autoConnect: false,
    }
    // 与 Tauri 那条对称：只答服务配置这一路，其余命令给 undefined。
    serverInvokeMock.mockImplementation(async (command: string) => {
      if (command === 'mcp_config_read') return { servers: [remoteConfig], toolNameCache: {} }
      return undefined
    })

    window.localStorage.clear()

    const { initializeMcpSettings: initializeFresh } = await import('./initialize')
    const { hydrateMcpSettings: hydrateFresh, removeMcpServer: removeFresh } =
      await import('./commands')
    const { mcpServerConfigsAtom } = await import('./state')
    const { uiStore } = await import('../uiStore')

    initializeFresh(SERVER_HOST)
    await hydrateFresh()

    // 无参命令：第二个实参显式是 undefined（serverMcpConfigStorage.ts 的记档）。
    expect(serverInvokeMock).toHaveBeenCalledWith('mcp_config_read', undefined)
    // 读到的确实是后端那份，不是 localStorage 里的旧数据。
    expect(uiStore.getter(mcpServerConfigsAtom).map((entry) => entry.id)).toEqual(['remote-server'])
    expect(window.localStorage.getItem(MCP_SETTINGS_STORAGE_KEY)).toBeNull()
    // server 宿主里没有 Tauri 原生层：一次 invoke 都不该发生。
    expect(invokeMock).not.toHaveBeenCalled()

    await removeFresh('remote-server')

    expect(serverInvokeMock.mock.calls).toContainEqual([
      'mcp_config_write',
      { patch: { servers: [] } },
    ])
    expect(window.localStorage.getItem(MCP_SETTINGS_STORAGE_KEY)).toBeNull()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  /**
   * 存储与 capabilities 之外的第三根线：**stdio 连接器本身**。
   *
   * 这条必须有，因为它的缺席是静默的：把 `...(serverHost ? { stdio: createServerStdioMcpConnector() } : {})`
   * 从 `initialize.ts` 删掉，storage 与 capabilities 两组用例**全绿**——`capabilities.stdio` 仍然为真，
   * 于是 `serverConnector.ts` 的准入闸照常放行，直到 `manager.connect` 才因为 router 里没有 stdio
   * 这个键而失败。症状是「配置能存、开关能开、一连就报一句 unsupported transport」，
   * 而病因在装配点的一行展开里。
   *
   * 判据取「连接请求真的经 `POST /api/invoke/mcp_connect` 发出去了」而不是「工厂被调用过」：
   * 后者只证明写了那行代码，前者证明这条路走得通。
   */
  it('server 宿主下 stdio 连接经 POST /api/invoke/mcp_connect —— 装上的是 server 版 connector', async () => {
    const { serverInvokeMock, invokeMock } = await freshHost(SERVER_HOST)
    // 事件流用的是全局 fetch（生产装配的 connector 不带 options）。给一个永不 resolve 的替身：
    // 本用例既不需要事件，也**绝不能**真的往 /api/events 发请求。
    vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
    try {
      window.localStorage.clear()
      const { stdioLaunchFingerprint } = await import('./stdioLaunchConsent')
      const base = {
        id: 'local-stdio',
        name: '本机 stdio 服务',
        transport: 'stdio' as const,
        command: 'node',
        args: ['/tmp/never-actually-spawned.js'],
        autoConnect: false,
      }
      // 起进程确认是 connect 路上的第二道闸（H2）；没有它连不到 connector 那一层。
      const stdioConfig = { ...base, launchConsent: { fingerprint: stdioLaunchFingerprint(base), approvedAt: 1 } }

      serverInvokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
        if (command === 'mcp_config_read') return { servers: [stdioConfig] }
        if (command === 'mcp_connect') {
          const input = (args as { input: { serverId: string, sessionToken: string } }).input
          return { serverId: input.serverId, sessionToken: input.sessionToken }
        }
        if (command === 'mcp_list_tools') return { tools: [] }
        return undefined
      })

      const { initializeMcpSettings: initializeFresh } = await import('./initialize')
      const { hydrateMcpSettings: hydrateFresh, reconnectMcpServer: reconnectFresh,
        disconnectMcpServer: disconnectFresh, isMcpServerConnected: isConnectedFresh } =
        await import('./commands')

      initializeFresh(SERVER_HOST)
      await hydrateFresh()
      await reconnectFresh('local-stdio')

      const connectCalls = serverInvokeMock.mock.calls.filter(([command]) => command === 'mcp_connect')
      expect(connectCalls).toHaveLength(1)
      expect(connectCalls[0]?.[1]).toEqual({
        input: expect.objectContaining({ serverId: 'local-stdio', command: 'node' }),
      })
      // 走通到底，不是只把请求发出去就算数。
      expect(isConnectedFresh('local-stdio')).toBe(true)
      // 全程没有一次落到 Tauri 原生层。
      expect(invokeMock).not.toHaveBeenCalled()

      await disconnectFresh('local-stdio')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('static 宿主下行为不变：装配仍走 localStorage 读写，两条命令通道都不碰', async () => {
    const { invokeMock, serverInvokeMock } = await freshHost(STATIC_HOST)

    window.localStorage.clear()
    // 与上面两个用例对称：直接在 localStorage 里放一份既有配置，证明装配读到的是
    // 浏览器存储而不是任何一条命令通道。
    window.localStorage.setItem(MCP_SETTINGS_STORAGE_KEY, JSON.stringify({
      version: 1,
      servers: [{
        id: 'browser-local',
        name: '浏览器里的服务',
        transport: 'streamable-http',
        url: 'https://browser.example.test/mcp',
        autoConnect: false,
      }],
    }))

    const { initializeMcpSettings: initializeFresh } = await import('./initialize')
    const { hydrateMcpSettings: hydrateFresh, removeMcpServer: removeFresh } =
      await import('./commands')

    initializeFresh(STATIC_HOST)
    await hydrateFresh()
    expect(invokeMock).not.toHaveBeenCalled()
    expect(serverInvokeMock).not.toHaveBeenCalled()

    await removeFresh('browser-local')

    expect(invokeMock).not.toHaveBeenCalled()
    expect(serverInvokeMock).not.toHaveBeenCalled()
    const stored = JSON.parse(window.localStorage.getItem(MCP_SETTINGS_STORAGE_KEY) ?? '{}')
    expect(stored.servers).toEqual([])
  })
})

/**
 * 两个 capability flag 回答的是**两个不同问题**（能不能在本机起子进程 / 凭据能不能落盘），
 * 只是恰好在 tauri 与 server 两态上同时为真。`initialize.ts` 的接线注释这么写了，
 * 但在此之前没有测试守着——把 `|| serverHost` 从任一个上删掉，两态就会静默地少一样能力：
 * stdio 少了会让 server 宿主的 stdio 服务连不上（`serverConnector.ts` 的准入判据），
 * credentials 少了会让凭据字段在设置面板里被判非法（`state.ts` 的 draft 校验）。
 */
describe('装配点按宿主态定 capabilities', () => {
  async function capabilitiesFor(host: ResolvedHost) {
    await freshHost(host)
    const { initializeMcpSettings: initializeFresh } = await import('./initialize')
    const { mcpSettingsCapabilitiesAtom } = await import('./state')
    const { uiStore } = await import('../uiStore')
    initializeFresh(host)
    return uiStore.getter(mcpSettingsCapabilitiesAtom)
  }

  it('tauri 宿主：stdio 与 credentials 都为真', async () => {
    expect(await capabilitiesFor(TAURI_HOST)).toEqual({ stdio: true, credentials: true })
  })

  it('server 宿主：stdio 与 credentials 都为真（本机 Node 后端替它 spawn、并读写同一份配置文件）', async () => {
    expect(await capabilitiesFor(SERVER_HOST)).toEqual({ stdio: true, credentials: true })
  })

  it('static 宿主：两者皆假', async () => {
    expect(await capabilitiesFor(STATIC_HOST)).toEqual({ stdio: false, credentials: false })
  })
})
