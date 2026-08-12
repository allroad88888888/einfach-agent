import { describe, expect, it, vi } from 'vitest'
import {
  createMcpConfigStorage,
  MCP_SETTINGS_STORAGE_KEY,
  sanitizeConfigs,
} from './persistence'
import type { PersistedMcpServerConfig } from './types'

/**
 * C1 的宿主分层：白名单（sanitizeConfigs）接受 headers / env，因为桌面配置文件是凭据的
 * 唯一落点；localStorage 宿主在读写两端都必须把它们剥掉。这两条规则的分界就是这个文件
 * 要钉住的东西——单独成文件而不是塞进 persistence.test.ts，是因为它测的是「凭据能不能进
 * 浏览器存储」这一件事，与那边的白名单/上限/去重不是同一个话题。
 */

const HTTP_WITH_HEADERS: PersistedMcpServerConfig = {
  id: 'remote',
  name: '远程',
  transport: 'streamable-http',
  url: 'https://example.com/mcp',
  headers: { Authorization: 'Bearer sk-example' },
  autoConnect: true,
}

const STDIO_WITH_ENV: PersistedMcpServerConfig = {
  id: 'local',
  name: '本地工具',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@example/mcp-server'],
  env: { API_KEY: 'k-1' },
  autoConnect: false,
}

function createFakeLocalStorage() {
  let stored: string | null = null
  return {
    getItem: () => stored,
    setItem: vi.fn((_key: string, value: string) => {
      stored = value
    }),
    read: () => stored,
  }
}

describe('MCP 凭据字段与存储宿主（C1）', () => {
  it('共用白名单保留凭据：桌面配置文件靠它净化用户手写的 headers / env', () => {
    expect(sanitizeConfigs([HTTP_WITH_HEADERS, STDIO_WITH_ENV])).toEqual([
      HTTP_WITH_HEADERS,
      STDIO_WITH_ENV,
    ])
  })

  it('localStorage 保存时剥掉凭据，写出去的字节里不含它们', async () => {
    const storage = createFakeLocalStorage()

    await createMcpConfigStorage(storage).save([HTTP_WITH_HEADERS, STDIO_WITH_ENV])

    expect(storage.setItem).toHaveBeenCalledTimes(1)
    expect(storage.setItem.mock.calls[0]?.[0]).toBe(MCP_SETTINGS_STORAGE_KEY)
    const serialized = String(storage.read())
    expect(serialized).not.toMatch(/headers|env|Authorization|API_KEY|sk-example|k-1/)
    expect(JSON.parse(serialized).servers).toEqual([
      {
        id: 'remote',
        name: '远程',
        transport: 'streamable-http',
        url: 'https://example.com/mcp',
        autoConnect: true,
      },
      {
        id: 'local',
        name: '本地工具',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@example/mcp-server'],
        autoConnect: false,
      },
    ])
  })

  it('localStorage 的 save/load 往返之后配置里不含 headers / env', async () => {
    const storage = createFakeLocalStorage()
    const configStorage = createMcpConfigStorage(storage)

    await configStorage.save([HTTP_WITH_HEADERS, STDIO_WITH_ENV])
    const loaded = await configStorage.load()

    expect(loaded.map((config) => config.id)).toEqual(['remote', 'local'])
    for (const config of loaded) {
      expect(config).not.toHaveProperty('headers')
      expect(config).not.toHaveProperty('env')
    }
  })

  it('读到存量里的凭据时就地清掉：读后回写把它们从浏览器存储里抹去', async () => {
    // 别的宿主写的、手改的、或者旧版本留下的——只要被读过一次就不该继续留在 localStorage。
    const setItem = vi.fn()
    const storage = createMcpConfigStorage({
      getItem: () => JSON.stringify({
        version: 1,
        servers: [HTTP_WITH_HEADERS, STDIO_WITH_ENV],
      }),
      setItem,
    })

    const loaded = await storage.load()

    expect(JSON.stringify(loaded)).not.toMatch(/headers|env|Authorization|API_KEY/)
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(String(setItem.mock.calls[0]?.[1]))
      .not.toMatch(/headers|env|Authorization|API_KEY|sk-example|k-1/)
  })
})
