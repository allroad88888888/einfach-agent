import { describe, expect, it, vi } from 'vitest'
import {
  createBrowserMcpConfigStorage,
  createMcpConfigStorage,
  createMemoryMcpConfigStorage,
  MCP_SETTINGS_MAX_SERVERS,
  MCP_SETTINGS_STORAGE_KEY,
} from './persistence'

function httpConfig(index: number) {
  return {
    id: `server-${index}`,
    name: `服务 ${index}`,
    transport: 'streamable-http' as const,
    url: `https://example.com/mcp/${index}`,
    autoConnect: false,
  }
}

describe('MCP config persistence', () => {
  it('defaults missing or invalid auto-connect values to the safe disabled state', () => {
    const storage = createMcpConfigStorage({
      getItem: () => JSON.stringify({
        version: 1,
        servers: [
          {
            id: 'missing-auto-connect',
            name: '缺少开关',
            transport: 'streamable-http',
            url: 'https://example.com/mcp/missing',
          },
          {
            id: 'invalid-auto-connect',
            name: '非法开关',
            transport: 'streamable-http',
            url: 'https://example.com/mcp/invalid',
            autoConnect: 'yes',
          },
        ],
      }),
      setItem: vi.fn(),
    })

    expect(storage.load()).toEqual([
      {
        id: 'missing-auto-connect',
        name: '缺少开关',
        transport: 'streamable-http',
        url: 'https://example.com/mcp/missing',
        autoConnect: false,
      },
      {
        id: 'invalid-auto-connect',
        name: '非法开关',
        transport: 'streamable-http',
        url: 'https://example.com/mcp/invalid',
        autoConnect: false,
      },
    ])
  })

  it('reports whether settings are durable or only held in memory', () => {
    const browserStorage = createMcpConfigStorage({
      getItem: () => null,
      setItem: vi.fn(),
    })
    const memoryStorage = createMemoryMcpConfigStorage()

    expect(browserStorage.persistence).toBe('persistent')
    expect(memoryStorage.persistence).toBe('temporary')
  })

  it('marks the browser fallback as temporary when localStorage is unavailable', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('blocked', 'SecurityError')
      },
    })

    try {
      const storage = createBrowserMcpConfigStorage()
      expect(storage.persistence).toBe('temporary')
      storage.save([httpConfig(1)])
      expect(storage.load()).toEqual([httpConfig(1)])
    } finally {
      if (descriptor) Object.defineProperty(window, 'localStorage', descriptor)
      else delete (window as { localStorage?: Storage }).localStorage
    }
  })

  it('loads only the explicit safe whitelist and drops secret-bearing configs', () => {
    const getItem = vi.fn(() => JSON.stringify({
      version: 1,
      servers: [
        {
          id: 'http',
          name: '远程',
          transport: 'streamable-http',
          url: 'https://example.com/mcp',
          autoConnect: true,
          headers: { Authorization: 'Bearer secret' },
          env: { TOKEN: 'secret' },
        },
        {
          id: 'stdio',
          name: '本地',
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          cwd: '/workspace',
          autoConnect: false,
          env: { API_KEY: 'secret' },
          headers: { Authorization: 'secret' },
        },
        {
          id: 'unsafe-url',
          name: '不安全',
          transport: 'streamable-http',
          url: 'https://example.com/mcp?api_key=secret',
          autoConnect: true,
        },
        {
          id: 'unsafe-url-query-value',
          name: '查询参数也不持久化',
          transport: 'streamable-http',
          url: 'https://example.com/mcp?key=sk-secret',
          autoConnect: true,
        },
        {
          id: 'unsafe-url-benign-query',
          name: '基础地址必须无查询参数',
          transport: 'streamable-http',
          url: 'https://example.com/mcp?page=1',
          autoConnect: false,
        },
        {
          id: 'unsafe-url-fragment',
          name: '不安全片段',
          transport: 'streamable-http',
          url: 'https://example.com/mcp#access_token=secret',
          autoConnect: true,
        },
        {
          id: 'unsafe-stdio-arg',
          name: '不安全参数',
          transport: 'stdio',
          command: 'node',
          args: ['server.js', '--token=secret'],
          autoConnect: true,
        },
        {
          id: 'unsafe-stdio-secret-value',
          name: '不安全参数值',
          transport: 'stdio',
          command: 'node',
          args: ['server.js', 'sk-secret'],
          autoConnect: false,
        },
      ],
    }))
    const setItem = vi.fn()
    const storage = createMcpConfigStorage({ getItem, setItem })

    const configs = storage.load()

    expect(configs).toEqual([
      {
        id: 'http',
        name: '远程',
        transport: 'streamable-http',
        url: 'https://example.com/mcp',
        autoConnect: true,
      },
      {
        id: 'stdio',
        name: '本地',
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
        cwd: '/workspace',
        autoConnect: false,
      },
    ])
    expect(JSON.stringify(configs)).not.toMatch(/Authorization|TOKEN|API_KEY|secret/)
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(String(setItem.mock.calls[0]?.[1]))
      .not.toMatch(/headers|env|Authorization|TOKEN|API_KEY|secret/)
  })

  it('sanitizes again before writing so headers and env can never reach storage', () => {
    const setItem = vi.fn()
    const storage = createMcpConfigStorage({ getItem: () => null, setItem })
    const structurallyUnsafe = [
      {
        id: 'http',
        name: '远程',
        transport: 'streamable-http',
        url: 'https://example.com/mcp',
        autoConnect: true,
        headers: { Authorization: 'secret' },
      },
      {
        id: 'stdio',
        name: '本地',
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
        autoConnect: true,
        env: { TOKEN: 'secret' },
      },
      {
        id: 'unsafe-stdio-arg',
        name: '不安全参数',
        transport: 'stdio',
        command: 'node',
        args: ['server.js', '--token=secret'],
        autoConnect: true,
      },
      {
        id: 'unsafe-stdio-secret-value',
        name: '不安全参数值',
        transport: 'stdio',
        command: 'node',
        args: ['server.js', 'sk-secret'],
        autoConnect: false,
      },
    ] as const

    storage.save(structurallyUnsafe)

    expect(setItem).toHaveBeenCalledTimes(1)
    expect(setItem.mock.calls[0]?.[0]).toBe(MCP_SETTINGS_STORAGE_KEY)
    const serialized = String(setItem.mock.calls[0]?.[1])
    expect(serialized).not.toMatch(/headers|env|Authorization|TOKEN|secret/)
    expect(JSON.parse(serialized)).toEqual({
      version: 1,
      servers: [
        {
          id: 'http',
          name: '远程',
          transport: 'streamable-http',
          url: 'https://example.com/mcp',
          autoConnect: true,
        },
        {
          id: 'stdio',
          name: '本地',
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          autoConnect: false,
        },
      ],
    })
  })

  it('rejects an oversized stored list instead of silently truncating it', () => {
    const servers = Array.from(
      { length: MCP_SETTINGS_MAX_SERVERS + 1 },
      (_, index) => httpConfig(index),
    )
    const storage = createMcpConfigStorage({
      getItem: () => JSON.stringify({ version: 1, servers }),
      setItem: vi.fn(),
    })

    expect(() => storage.load()).toThrow(`最多只能配置 ${MCP_SETTINGS_MAX_SERVERS} 个`)
  })

  it('enforces the same explicit limit before browser or memory writes', () => {
    const configs = Array.from(
      { length: MCP_SETTINGS_MAX_SERVERS + 1 },
      (_, index) => httpConfig(index),
    )
    const setItem = vi.fn()
    const browserStorage = createMcpConfigStorage({ getItem: () => null, setItem })
    const memoryStorage = createMemoryMcpConfigStorage()

    expect(() => browserStorage.save(configs)).toThrow(
      `最多只能配置 ${MCP_SETTINGS_MAX_SERVERS} 个`,
    )
    expect(setItem).not.toHaveBeenCalled()
    expect(() => memoryStorage.save(configs)).toThrow(
      `最多只能配置 ${MCP_SETTINGS_MAX_SERVERS} 个`,
    )
  })

  it('rejects duplicate server ids instead of creating ambiguous runtime ownership', () => {
    const duplicate = [httpConfig(1), { ...httpConfig(2), id: 'server-1' }]
    const storage = createMcpConfigStorage({
      getItem: () => JSON.stringify({ version: 1, servers: duplicate }),
      setItem: vi.fn(),
    })

    expect(() => storage.load()).toThrow('MCP 服务 ID 重复：server-1')
    expect(() => createMemoryMcpConfigStorage(duplicate)).toThrow(
      'MCP 服务 ID 重复：server-1',
    )
  })
})
