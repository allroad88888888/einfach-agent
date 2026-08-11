import { createStore } from '@einfach/core'
import { describe, expect, it, vi } from 'vitest'
import { mcpPendingLaunchConsentsAtom } from './launchConsentState'
import type { McpConfigStorage } from './persistence'
import { createMcpRuntimeWriters } from './runtimeWriters'
import { createMcpServerConnector } from './serverConnector'
import { createMcpSettingsService } from './service'
import { createStorage, FakeMcpManager } from './service.fixtures'
import { grantStdioLaunchConsent, stdioLaunchFingerprint } from './stdioLaunchConsent'
import { mcpServerConfigsAtom, mcpServersAtom } from './state'
import type { PersistedMcpServerConfig, PersistedStdioMcpServer } from './types'

/**
 * H2 的四个路口：安装探测、冷启动自动连接、手动重连、打开自动连接。
 *
 * 每一处的判据都一样——「这条命令行被用户确认过吗」（mayLaunchMcpServer）——所以每一处
 * 都有一对用例：未确认时【一个进程都不起】，确认之后照常走。安装探测那一对在
 * probeOnInstall.test.ts（它是 B2 的桩被解除的地方）。
 */

const PLAYWRIGHT: PersistedStdioMcpServer = {
  id: 'playwright',
  name: 'Playwright MCP',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@playwright/mcp@latest'],
  autoConnect: true,
}

function serviceWith(
  configs: readonly PersistedMcpServerConfig[],
  options: { stdio?: boolean } = {},
) {
  const store = createStore()
  const manager = new FakeMcpManager()
  const { storage, save } = createStorage(configs)
  const service = createMcpSettingsService({
    store,
    manager,
    storage,
    capabilities: { stdio: options.stdio !== false },
  })
  return { store, manager, storage, save, service }
}

describe('MCP 起进程确认（H2）· 最后一道防线', () => {
  it('直接调 connector 也连不上未确认的 stdio：门在 manager.connect 之前', async () => {
    // 上面那些用例守的是「每个入口都会先问」；这一条守的是「万一某个入口漏了问」。
    const store = createStore()
    const manager = new FakeMcpManager()
    const connector = createMcpServerConnector({
      manager,
      writers: createMcpRuntimeWriters(store),
      capabilities: { stdio: true },
      isConfigured: () => true,
    })
    store.setter(mcpServerConfigsAtom, [PLAYWRIGHT])

    await connector.connect(PLAYWRIGHT, { reconnect: false })

    expect(manager.connectCalls).toHaveLength(0)
    expect(store.getter(mcpServersAtom)[0]).toEqual(expect.objectContaining({
      status: 'error',
      error: '启动命令尚未确认，未启动本地进程',
    }))

    // 登记（F6：只登记不连接）不受影响——connect_mcp_server 仍然找得到这个服务，
    // 模型那条路径有 F3 自己的确认门。
    await connector.register(PLAYWRIGHT)
    expect(manager.registerCalls.map((config) => config.id)).toEqual(['playwright'])
  })
})

describe('MCP 起进程确认（H2）· 冷启动', () => {
  it('确认过的 stdio 照常自动连接，且不再问第二次', async () => {
    const { store, manager, service } = serviceWith([
      grantStdioLaunchConsent(PLAYWRIGHT, 1_700_000_000_000),
    ])

    await service.hydrate()

    expect(manager.connectCalls.map((config) => config.id)).toEqual(['playwright'])
    // 确认已经落在配置里，冷启动不该再摆一次确认。
    expect(store.getter(mcpPendingLaunchConsentsAtom)).toEqual({})
    expect(store.getter(mcpServersAtom)[0]).toEqual(
      expect.objectContaining({ status: 'connected', toolCount: 1 }),
    )
  })

  it('确认过、但命令后来被改过：指纹对不上，既不自动连接也不擅自补一次确认', async () => {
    // 现在没有编辑配置的界面，但 config.json 是用户可以直接改的；F6 的实现者也提醒过
    // 将来会有编辑路径。确认绑在命令行上，所以这种情况【自动】失效，不依赖编辑路径
    // 记得去清标记。
    const edited: PersistedStdioMcpServer = {
      ...grantStdioLaunchConsent(PLAYWRIGHT, 1_700_000_000_000),
      command: 'rm',
      args: ['-rf', '/'],
    }
    const { store, manager, save, service } = serviceWith([edited])

    await service.hydrate()

    expect(manager.connectCalls).toHaveLength(0)
    expect(store.getter(mcpPendingLaunchConsentsAtom)).toEqual({})
    // 冷启动不改盘：作废的确认原样留着，用户把命令改回去就还算数。
    expect(save).not.toHaveBeenCalled()
    expect(store.getter(mcpServersAtom)[0]).toEqual(
      expect.objectContaining({ status: 'disconnected', autoConnect: true }),
    )
  })
})

describe('MCP 起进程确认（H2）· 手动重连', () => {
  it('未确认时只排确认请求；确认后连上，并把确认落进配置', async () => {
    const { store, save, service, manager: fake } = serviceWith([
      { ...PLAYWRIGHT, autoConnect: false },
    ])
    await service.hydrate()

    await service.reconnect('playwright')

    expect(fake.connectCalls).toHaveLength(0)
    expect(fake.reconnectCalls).toHaveLength(0)
    expect(store.getter(mcpPendingLaunchConsentsAtom).playwright).toEqual({
      id: 'playwright',
      name: 'Playwright MCP',
      commandLine: 'npx -y @playwright/mcp@latest',
      reason: 'connect',
      autoConnect: false,
    })

    await service.approveLaunch('playwright')

    expect(fake.reconnectCalls).toEqual(['playwright'])
    expect(store.getter(mcpPendingLaunchConsentsAtom)).toEqual({})
    const [stored] = store.getter(mcpServerConfigsAtom)
    expect(stored).toEqual(expect.objectContaining({
      launchConsent: {
        fingerprint: stdioLaunchFingerprint(PLAYWRIGHT),
        approvedAt: expect.any(Number),
      },
    }))
    expect(save).toHaveBeenLastCalledWith([stored])
  })

  it('暂不执行：请求撤掉，进程不起，配置里也不会留下确认', async () => {
    const { store, service, manager: fake } = serviceWith([
      { ...PLAYWRIGHT, autoConnect: false },
    ])
    await service.hydrate()
    await service.reconnect('playwright')

    service.dismissLaunch('playwright')

    expect(store.getter(mcpPendingLaunchConsentsAtom)).toEqual({})
    expect(fake.connectCalls).toHaveLength(0)
    expect(fake.reconnectCalls).toHaveLength(0)
    expect(store.getter(mcpServerConfigsAtom)[0]).not.toHaveProperty('launchConsent')

    // 撤掉之后再点一次确认没有对象可执行，绝不能补跑一次。
    await service.approveLaunch('playwright')
    expect(fake.connectCalls).toHaveLength(0)
    expect(fake.reconnectCalls).toHaveLength(0)
  })

  it('确认过之后不再重复问：断开再重连直接连上', async () => {
    const { store, service, manager: fake } = serviceWith([
      grantStdioLaunchConsent({ ...PLAYWRIGHT, autoConnect: false }, 1_700_000_000_000),
    ])
    await service.hydrate()

    await service.reconnect('playwright')
    await service.disconnect('playwright')
    await service.reconnect('playwright')

    expect(fake.reconnectCalls).toEqual(['playwright', 'playwright'])
    expect(store.getter(mcpPendingLaunchConsentsAtom)).toEqual({})
  })

  it('浏览器里不问：那里根本没有 stdio 连接器，弹一个不会发生的执行确认只是噪音', async () => {
    const { store, service, manager: fake } = serviceWith(
      [{ ...PLAYWRIGHT, autoConnect: false }],
      { stdio: false },
    )
    await service.hydrate()

    await service.reconnect('playwright')

    expect(store.getter(mcpPendingLaunchConsentsAtom)).toEqual({})
    expect(fake.connectCalls).toHaveLength(0)
    expect(store.getter(mcpServersAtom)[0]).toEqual(
      expect.objectContaining({ status: 'error', error: 'stdio MCP 仅可在桌面端连接' }),
    )
  })

  it('确认排队期间服务被删掉：确认不执行任何东西', async () => {
    const { store, service, manager: fake } = serviceWith([
      { ...PLAYWRIGHT, autoConnect: false },
    ])
    await service.hydrate()
    await service.reconnect('playwright')

    await service.remove('playwright')
    await service.approveLaunch('playwright')

    expect(fake.connectCalls).toHaveLength(0)
    expect(fake.reconnectCalls).toHaveLength(0)
    expect(store.getter(mcpPendingLaunchConsentsAtom)).toEqual({})
    expect(store.getter(mcpServerConfigsAtom)).toEqual([])
  })
})

describe('MCP 起进程确认（H2）· 打开自动连接', () => {
  it('偏好照常落盘，但这一刻不起进程——改成问一次，确认后才连', async () => {
    const { store, save, service, manager } = serviceWith([
      { ...PLAYWRIGHT, autoConnect: false },
    ])
    await service.hydrate()

    await service.setAutoConnect('playwright', true)

    // H1 的数据模型：偏好是普通字段，存下来；H2：执行权另算。
    expect(save).toHaveBeenCalledWith([expect.objectContaining({ autoConnect: true })])
    expect(manager.connectCalls).toHaveLength(0)
    expect(store.getter(mcpPendingLaunchConsentsAtom).playwright).toEqual(
      expect.objectContaining({ reason: 'auto-connect', autoConnect: true }),
    )

    await service.approveLaunch('playwright')

    expect(manager.connectCalls.map((config) => config.id)).toEqual(['playwright'])
    expect(store.getter(mcpServersAtom)[0]).toEqual(
      expect.objectContaining({ status: 'connected', autoConnect: true }),
    )
  })

  it('关闭自动连接从来不需要确认', async () => {
    const { store, service, manager } = serviceWith([
      grantStdioLaunchConsent(PLAYWRIGHT, 1_700_000_000_000),
    ])
    await service.hydrate()

    await service.setAutoConnect('playwright', false)

    expect(manager.disconnectCalls).toEqual(['playwright'])
    expect(store.getter(mcpPendingLaunchConsentsAtom)).toEqual({})
  })

  it('确认落盘走的是 A3 的 transform 队列，不会丢掉并发写入的另一个服务', async () => {
    // 确认是一个新的 persist 调用点，必须和其它写入一样只在自己那一轮里读 atom。
    const other: PersistedMcpServerConfig = {
      id: 'remote',
      name: '远端服务',
      transport: 'streamable-http',
      url: 'https://remote.example.com/mcp',
      autoConnect: false,
    }
    let persisted: readonly PersistedMcpServerConfig[] = [
      { ...PLAYWRIGHT, autoConnect: false },
      other,
    ]
    const load = vi.fn<McpConfigStorage['load']>(async () => persisted)
    const save = vi.fn<McpConfigStorage['save']>(async (next) => {
      for (let tick = 0; tick < 20; tick += 1) await Promise.resolve()
      persisted = [...next]
    })
    const store = createStore()
    const manager = new FakeMcpManager()
    const service = createMcpSettingsService({
      store,
      manager,
      storage: { persistence: 'persistent', load, save },
      capabilities: { stdio: true },
    })
    await service.hydrate()
    await service.reconnect('playwright')

    await Promise.all([
      service.approveLaunch('playwright'),
      service.setAutoConnect('remote', true),
    ])

    expect(persisted.find((config) => config.id === 'playwright')).toEqual(
      expect.objectContaining({
        launchConsent: expect.objectContaining({
          fingerprint: stdioLaunchFingerprint(PLAYWRIGHT),
        }),
      }),
    )
    expect(persisted.find((config) => config.id === 'remote')?.autoConnect).toBe(true)
  })
})
