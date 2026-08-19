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
// 【两份状态必须落到同一处 · C7】"服务配置"与"工具名缓存"是同一个宿主上的两份状态，所以每个
// 用例都同时钉住两半。此前只钉了配置那一半，而缓存由 service 的默认值经
// `createDesktopToolNameCacheStorage()` 自己 `isTauri()` 再探一次决定——server 宿主下它答 false，
// 于是配置进了 `~/.webAgent/config.json`、缓存落进浏览器 localStorage，分家且不报错。
//
// 【`isTauri()` 一次都不该被调用】这是 C7 的结构性判据，比"缓存落对了"更早一层：宿主态的唯一
// 权威是 `resolveHost()`，装配点及其调用到的每个工厂都只能用递进来的那个 `host`。

import { describe, expect, it, vi } from 'vitest'
import { MCP_SETTINGS_STORAGE_KEY } from './persistence'
import {
  cacheFor,
  DECOY,
  freshHost,
  readBrowserCache,
  seedBrowserCache,
  SERVER_HOST,
  STATIC_HOST,
  TAURI_HOST,
} from './initialize.testHarness'

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

describe('装配点按宿主态选存储后端', () => {
  it('Tauri 宿主下，服务配置的读写都经 mcp_config_read / mcp_config_write，不落 localStorage', async () => {
    const { invokeMock, serverInvokeMock, isTauriMock } = await freshHost()

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
      if (command === 'mcp_config_read') {
        return { servers: [remoteConfig], toolNameCache: cacheFor('remote-desktop') }
      }
      return undefined
    })

    window.localStorage.clear()
    seedBrowserCache(DECOY)

    const { initializeMcpSettings: initializeFresh } = await import('./initialize')
    const { hydrateMcpSettings: hydrateFresh, removeMcpServer: removeFresh,
      readMcpToolNameCache: readCacheFresh } = await import('./commands')

    initializeFresh(TAURI_HOST)
    await hydrateFresh()

    expect(invokeMock).toHaveBeenCalledWith('mcp_config_read')
    // 装配读到的服务确实来自 mcp_config_read，不是 localStorage 里的旧数据。
    expect(window.localStorage.getItem(MCP_SETTINGS_STORAGE_KEY)).toBeNull()
    // 缓存那一半读的是同一条通道：拿到的是配置文件里那条，不是 localStorage 里的诱饵。
    expect(Object.keys(readCacheFresh())).toEqual(['remote-desktop'])
    // 桌面态一次都不该碰 HTTP 那条路。
    expect(serverInvokeMock).not.toHaveBeenCalled()

    await removeFresh('remote-desktop')

    const writeCalls = invokeMock.mock.calls.filter(([command]) => command === 'mcp_config_write')
    expect(writeCalls).toContainEqual(['mcp_config_write', { patch: { servers: [] } }])
    // 删除级联清缓存（A2）也落回同一条通道。
    expect(writeCalls).toContainEqual(['mcp_config_write', { patch: { toolNameCache: {} } }])
    // 全程没有一次写落到浏览器存储：配置那把键仍是空的，诱饵一个字节没动过。
    expect(window.localStorage.getItem(MCP_SETTINGS_STORAGE_KEY)).toBeNull()
    expect(readBrowserCache()).toEqual(cacheFor(DECOY))
    expect(isTauriMock).not.toHaveBeenCalled()
  })

  it('server 宿主下，服务配置经 POST /api/invoke/mcp_config_*，既不落 localStorage 也不碰 Tauri', async () => {
    const { invokeMock, serverInvokeMock, isTauriMock } = await freshHost()

    const remoteConfig = {
      id: 'remote-server',
      name: '本机后端配置里的服务',
      transport: 'streamable-http' as const,
      url: 'https://server.example.test/mcp',
      autoConnect: false,
    }
    // 与 Tauri 那条对称：只答服务配置这一路，其余命令给 undefined。
    serverInvokeMock.mockImplementation(async (command: string) => {
      if (command === 'mcp_config_read') {
        return { servers: [remoteConfig], toolNameCache: cacheFor('remote-server') }
      }
      return undefined
    })

    window.localStorage.clear()
    seedBrowserCache(DECOY)

    const { initializeMcpSettings: initializeFresh } = await import('./initialize')
    const { hydrateMcpSettings: hydrateFresh, removeMcpServer: removeFresh,
      readMcpToolNameCache: readCacheFresh } = await import('./commands')
    const { mcpServerConfigsAtom } = await import('./state')
    const { uiStore } = await import('../uiStore')

    initializeFresh(SERVER_HOST)
    await hydrateFresh()

    // 无参命令：第二个实参显式是 undefined（serverMcpConfigStorage.ts 的记档）。
    expect(serverInvokeMock).toHaveBeenCalledWith('mcp_config_read', undefined)
    // 读到的确实是后端那份，不是 localStorage 里的旧数据。
    expect(uiStore.getter(mcpServerConfigsAtom).map((entry) => entry.id)).toEqual(['remote-server'])
    expect(window.localStorage.getItem(MCP_SETTINGS_STORAGE_KEY)).toBeNull()
    // C7 的正题：缓存与配置落在**同一处**。走岔的话这里读回来的会是 localStorage 里的诱饵。
    expect(Object.keys(readCacheFresh())).toEqual(['remote-server'])
    // server 宿主里没有 Tauri 原生层：一次 invoke 都不该发生。
    expect(invokeMock).not.toHaveBeenCalled()

    await removeFresh('remote-server')

    expect(serverInvokeMock.mock.calls).toContainEqual([
      'mcp_config_write',
      { patch: { servers: [] } },
    ])
    // 删除级联清缓存（A2）同样经 HTTP 那条通道落回配置文件。
    expect(serverInvokeMock.mock.calls).toContainEqual([
      'mcp_config_write',
      { patch: { toolNameCache: {} } },
    ])
    expect(window.localStorage.getItem(MCP_SETTINGS_STORAGE_KEY)).toBeNull()
    expect(readBrowserCache()).toEqual(cacheFor(DECOY))
    expect(invokeMock).not.toHaveBeenCalled()
    expect(isTauriMock).not.toHaveBeenCalled()
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
    const { serverInvokeMock, invokeMock } = await freshHost()
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
    const { invokeMock, serverInvokeMock, isTauriMock } = await freshHost()

    window.localStorage.clear()
    // 这一态里 localStorage 不是诱饵而是**唯一**的通道，缓存也一样。
    seedBrowserCache('browser-local')
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
    const { hydrateMcpSettings: hydrateFresh, removeMcpServer: removeFresh,
      readMcpToolNameCache: readCacheFresh } = await import('./commands')

    initializeFresh(STATIC_HOST)
    await hydrateFresh()
    expect(invokeMock).not.toHaveBeenCalled()
    expect(serverInvokeMock).not.toHaveBeenCalled()
    expect(Object.keys(readCacheFresh())).toEqual(['browser-local'])

    await removeFresh('browser-local')

    expect(invokeMock).not.toHaveBeenCalled()
    expect(serverInvokeMock).not.toHaveBeenCalled()
    const stored = JSON.parse(window.localStorage.getItem(MCP_SETTINGS_STORAGE_KEY) ?? '{}')
    expect(stored.servers).toEqual([])
    // 缓存那一半同样落回浏览器：级联清理写的是 localStorage，不是任何一条命令通道。
    expect(readBrowserCache()).toEqual({})
    expect(isTauriMock).not.toHaveBeenCalled()
  })
})
