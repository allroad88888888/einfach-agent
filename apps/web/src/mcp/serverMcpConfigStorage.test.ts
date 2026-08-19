import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeServerCommand, ServerInvokeError } from '../host/serverInvoke'
import { MCP_SETTINGS_STORAGE_KEY } from './persistence'
import type { PersistedMcpServerConfig } from './types'
import { createServerMcpConfigStorage } from './serverMcpConfigStorage'

// 只替 `invokeServerCommand`，`ServerInvokeError` 保留真身——失败翻译判的是 `instanceof`
// 与 `.status`，换成假的就测不到真实形状了。
vi.mock('../host/serverInvoke', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../host/serverInvoke')>()
  return { ...actual, invokeServerCommand: vi.fn() }
})

const invokeMock = vi.mocked(invokeServerCommand)

function httpConfig(index: number): PersistedMcpServerConfig {
  return {
    id: `server-${index}`,
    name: `服务 ${index}`,
    transport: 'streamable-http',
    url: `https://example.com/mcp/${index}`,
    autoConnect: false,
  }
}

describe('server 宿主的 MCP 配置存储', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    window.localStorage.clear()
  })

  it('经 mcp_config_read 读出 servers 键，命令名与参数形状与桌面版一致', async () => {
    invokeMock.mockResolvedValueOnce({ servers: [httpConfig(1), httpConfig(2)] })
    const storage = createServerMcpConfigStorage()

    expect(await storage.load()).toEqual([httpConfig(1), httpConfig(2)])
    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock).toHaveBeenCalledWith('mcp_config_read', undefined)
    expect(storage.persistence).toBe('persistent')
  })

  it('整段缺失或 servers 键缺席时，没有存量就是空清单', async () => {
    invokeMock.mockResolvedValueOnce({})
    expect(await createServerMcpConfigStorage().load()).toEqual([])
    invokeMock.mockResolvedValueOnce(undefined)
    expect(await createServerMcpConfigStorage().load()).toEqual([])
  })

  it('save 经 mcp_config_write 写 patch.servers，与桌面版逐字同形', async () => {
    invokeMock.mockResolvedValueOnce(undefined)
    await createServerMcpConfigStorage().save([httpConfig(1)])

    expect(invokeMock).toHaveBeenCalledWith('mcp_config_write', {
      patch: { servers: [httpConfig(1)] },
    })
  })

  it('净化规则与 localStorage 实现相同：不安全字段整条丢弃', async () => {
    invokeMock.mockResolvedValueOnce({
      servers: [
        {
          id: 'http',
          name: '远程',
          transport: 'streamable-http',
          url: 'https://example.com/mcp?api_key=secret',
          autoConnect: true,
        },
        {
          id: 'stdio',
          name: '本地',
          transport: 'stdio',
          command: 'node',
          args: ['server.js', '--token=secret'],
          autoConnect: true,
          timeout: 30,
        },
      ],
    })

    expect(await createServerMcpConfigStorage().load()).toEqual([])
  })

  it('凭据字段在配置文件这条路上原样往返（与 localStorage 宿主相反）', async () => {
    const servers = [
      {
        id: 'http',
        name: '远程',
        transport: 'streamable-http' as const,
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer sk-example' },
        autoConnect: true,
      },
      {
        id: 'stdio',
        name: '本地',
        transport: 'stdio' as const,
        command: 'node',
        args: ['server.js'],
        env: { API_KEY: 'k-1' },
        autoConnect: false,
      },
    ]
    invokeMock.mockResolvedValueOnce(undefined)
    const storage = createServerMcpConfigStorage()

    await storage.save(servers)
    expect(invokeMock).toHaveBeenCalledWith('mcp_config_write', { patch: { servers } })

    invokeMock.mockResolvedValueOnce({ servers })
    expect(await storage.load()).toEqual(servers)
  })

  it('servers 键格式非法时报错，绝不用迁移覆盖它', async () => {
    invokeMock.mockResolvedValueOnce({ servers: 'not-an-array' })
    await expect(createServerMcpConfigStorage().load()).rejects.toThrow('servers 字段格式无效')
  })

  it('读失败折成一句带前缀的中文，而不是把 HTTP 失败原样漏出去', async () => {
    invokeMock.mockRejectedValueOnce(new ServerInvokeError({
      status: 500,
      code: undefined,
      message: '本地服务返回了非预期的错误响应（HTTP 500）。',
    }))

    await expect(createServerMcpConfigStorage().load()).rejects.toThrow(
      '无法读取 MCP 配置：本地服务返回了非预期的错误响应（HTTP 500）。',
    )
  })

  it('写失败同样折成一句带前缀的中文', async () => {
    invokeMock.mockRejectedValueOnce(new ServerInvokeError({
      status: undefined,
      code: undefined,
      message: '无法连接本地服务：fetch failed',
    }))

    await expect(createServerMcpConfigStorage().save([httpConfig(1)])).rejects.toThrow(
      '无法保存 MCP 配置：无法连接本地服务：fetch failed',
    )
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })

  it('超过持久化上限时在发命令之前就拒绝', async () => {
    const configs = Array.from({ length: 51 }, (_, index) => httpConfig(index))

    await expect(createServerMcpConfigStorage().save(configs)).rejects.toThrow('最多只能配置 50 个')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('servers 键缺席且 localStorage 有存量时，把存量一次性搬进配置文件', async () => {
    window.localStorage.setItem(MCP_SETTINGS_STORAGE_KEY, JSON.stringify({
      version: 1,
      servers: [httpConfig(7)],
    }))
    invokeMock.mockResolvedValueOnce({})
    invokeMock.mockResolvedValueOnce(undefined)
    const storage = createServerMcpConfigStorage()

    expect(await storage.load()).toEqual([httpConfig(7)])
    expect(invokeMock).toHaveBeenNthCalledWith(2, 'mcp_config_write', {
      patch: { servers: [httpConfig(7)] },
    })
  })

  it('servers 键存在但是空数组时以配置文件为准，不触发迁移', async () => {
    window.localStorage.setItem(MCP_SETTINGS_STORAGE_KEY, JSON.stringify({
      version: 1,
      servers: [httpConfig(7)],
    }))
    invokeMock.mockResolvedValueOnce({ servers: [] })

    expect(await createServerMcpConfigStorage().load()).toEqual([])
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })
})
