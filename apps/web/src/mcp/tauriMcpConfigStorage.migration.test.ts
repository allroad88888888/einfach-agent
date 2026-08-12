import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { MCP_SETTINGS_STORAGE_KEY } from './persistence'
import { stdioLaunchFingerprint } from './stdioLaunchConsent'
import type { PersistedMcpServerConfig, PersistedStdioMcpServer } from './types'
import { createTauriMcpConfigStorage } from './tauriMcpConfigStorage'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}))

const invokeMock = vi.mocked(invoke)

function httpConfig(index: number): PersistedMcpServerConfig {
  return {
    id: `server-${index}`,
    name: `服务 ${index}`,
    transport: 'streamable-http',
    url: `https://example.com/mcp/${index}`,
    autoConnect: false,
  }
}

function stdioConfig(): PersistedStdioMcpServer {
  const config: PersistedStdioMcpServer = {
    id: 'local',
    name: '本地服务',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@some/mcp'],
    autoConnect: true,
  }
  return {
    ...config,
    launchConsent: { fingerprint: stdioLaunchFingerprint(config), approvedAt: 1_700_000_000_000 },
  }
}

/** 往 localStorage 放一份存量，返回原始字符串以便断言迁移没有改写它。 */
function seedLegacyStorage(configs: readonly PersistedMcpServerConfig[]): string {
  const raw = JSON.stringify({ version: 1, servers: configs })
  window.localStorage.setItem(MCP_SETTINGS_STORAGE_KEY, raw)
  return raw
}

/** 让 mcp_config_read 返回给定的 mcp 段，mcp_config_write 恒成功。 */
function mockConfigSection(section: unknown): void {
  invokeMock.mockImplementation((command) => {
    if (command === 'mcp_config_read') return Promise.resolve(section)
    if (command === 'mcp_config_write') return Promise.resolve(undefined)
    return Promise.reject(new Error(`未预期的命令：${String(command)}`))
  })
}

function writtenServers(): unknown[] {
  return invokeMock.mock.calls
    .filter(([command]) => command === 'mcp_config_write')
    .map(([, args]) => (args as { patch: { servers: unknown } }).patch.servers)
}

describe('localStorage 存量服务配置的一次性迁移', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('配置文件没有 servers 键时，把净化后的存量写进配置文件并原样保留 localStorage', async () => {
    const raw = seedLegacyStorage([httpConfig(1), stdioConfig()])
    mockConfigSection({})
    const storage = createTauriMcpConfigStorage()

    const loaded = await storage.load()

    expect(loaded).toEqual([httpConfig(1), stdioConfig()])
    expect(writtenServers()).toEqual([[httpConfig(1), stdioConfig()]])
    expect(window.localStorage.getItem(MCP_SETTINGS_STORAGE_KEY)).toBe(raw)
  })

  it('stdio 的起进程确认随配置一起迁移', async () => {
    seedLegacyStorage([stdioConfig()])
    mockConfigSection({})

    await createTauriMcpConfigStorage().load()

    expect(writtenServers()).toEqual([[expect.objectContaining({
      id: 'local',
      launchConsent: stdioConfig().launchConsent,
    })]])
  })

  // C1 之后 headers / env 是白名单里的合法字段，但**只有配置文件**该存它们。localStorage
  // 里出现的凭据只可能是手工塞的或被注入的，迁移一律不搬（理由见 legacyServerMigration.ts）。
  it('迁移写入的是净化结果，存量里的凭据字段不会被搬进配置文件', async () => {
    const consented = stdioConfig()
    window.localStorage.setItem(MCP_SETTINGS_STORAGE_KEY, JSON.stringify({
      version: 1,
      servers: [
        { ...httpConfig(1), headers: { Authorization: 'Bearer secret' } },
        // 给一条早已确认过的命令行补 env 不会让指纹失效，搬过去就等于让浏览器侧的写入
        // 权限升格成本机执行权限。
        { ...consented, env: { LD_PRELOAD: '/tmp/evil.so' } },
      ],
    }))
    mockConfigSection({})

    expect(await createTauriMcpConfigStorage().load()).toEqual([httpConfig(1), consented])
    expect(writtenServers()).toEqual([[httpConfig(1), consented]])
  })

  it('servers 键已存在时不迁移，空数组同样以配置文件为准', async () => {
    seedLegacyStorage([httpConfig(1)])
    mockConfigSection({ servers: [] })

    expect(await createTauriMcpConfigStorage().load()).toEqual([])
    expect(writtenServers()).toEqual([])
  })

  it('迁移是幂等的：配置文件有了 servers 键之后不再重写', async () => {
    seedLegacyStorage([httpConfig(1)])
    mockConfigSection({})

    const first = await createTauriMcpConfigStorage().load()
    // 迁移写进去之后，下一次冷启动读到的就是带 servers 键的配置段。
    mockConfigSection({ servers: [httpConfig(1)] })
    const second = await createTauriMcpConfigStorage().load()

    expect(second).toEqual(first)
    expect(writtenServers()).toEqual([[httpConfig(1)]])
  })

  it('同一实例上的并发 load 只迁移一次', async () => {
    seedLegacyStorage([httpConfig(1)])
    mockConfigSection({})
    const storage = createTauriMcpConfigStorage()

    const [first, second] = await Promise.all([storage.load(), storage.load()])

    expect(first).toEqual([httpConfig(1)])
    expect(second).toEqual(first)
    expect(writtenServers()).toHaveLength(1)
  })

  it('servers 键格式非法时报错，不用存量覆盖它', async () => {
    seedLegacyStorage([httpConfig(1)])
    mockConfigSection({ servers: 'not-an-array' })

    await expect(createTauriMcpConfigStorage().load()).rejects.toThrow('servers 字段格式无效')
    expect(writtenServers()).toEqual([])
  })

  it('存量本身坏掉时跳过迁移，load 仍返回空清单', async () => {
    window.localStorage.setItem(MCP_SETTINGS_STORAGE_KEY, '{ 不是 JSON')
    mockConfigSection({})

    expect(await createTauriMcpConfigStorage().load()).toEqual([])
    expect(writtenServers()).toEqual([])
  })

  it('localStorage 访问抛错时 load 不受影响', async () => {
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage access denied')
    })
    mockConfigSection({})

    expect(await createTauriMcpConfigStorage().load()).toEqual([])
    expect(writtenServers()).toEqual([])
  })

  it('迁移写入失败时 load 仍返回存量配置', async () => {
    seedLegacyStorage([httpConfig(1)])
    invokeMock.mockImplementation((command) => {
      if (command === 'mcp_config_read') return Promise.resolve({})
      return Promise.reject('mcp 配置段格式无效')
    })

    expect(await createTauriMcpConfigStorage().load()).toEqual([httpConfig(1)])
  })
})
