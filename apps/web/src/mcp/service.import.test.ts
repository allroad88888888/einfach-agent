import { createStore } from '@einfach/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMcpSettingsService } from './service'
import { createStorage, FakeMcpManager } from './service.fixtures'
import { createMemoryToolNameCacheStorage } from './toolNameCacheStorage'
import {
  mcpFormErrorAtom,
  mcpServerConfigsAtom,
  mcpServersAtom,
} from './state'
import type { PersistedMcpServerConfig } from './types'

const PLAYWRIGHT_MCP_JSON = `{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest"
      ]
    }
  }
}`

/** JSON 批量导入这一条路径：落盘原子性、命名冲突、以及导入后的探测边界。 */
describe('MCP settings service · JSON 导入', () => {
  let manager: FakeMcpManager

  beforeEach(() => {
    manager = new FakeMcpManager()
  })

  it('imports the common Playwright JSON in a browser without starting the stdio process', async () => {
    const store = createStore()
    const { storage, save } = createStorage()
    const service = createMcpSettingsService({
      store,
      manager,
      storage,
      capabilities: { stdio: false },
      createId: () => 'playwright',
    })

    await expect(service.importJson(PLAYWRIGHT_MCP_JSON)).resolves.toBe(true)

    const expected: PersistedMcpServerConfig = {
      id: 'playwright',
      name: 'playwright',
      transport: 'stdio',
      command: 'npx',
      args: ['@playwright/mcp@latest'],
      autoConnect: false,
    }
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith([expected])
    expect(manager.connectCalls).toHaveLength(0)
    expect(store.getter(mcpServerConfigsAtom)).toEqual([expected])
    expect(store.getter(mcpServersAtom)).toEqual([
      expect.objectContaining({
        id: 'playwright',
        status: 'disconnected',
        toolCount: 0,
      }),
    ])
  })

  it('imports multiple services in one save and leaves every transport manual-only', async () => {
    const store = createStore()
    const { storage, save } = createStorage()
    const ids = ['local-playwright', 'remote-search']
    let nextId = 0
    const service = createMcpSettingsService({
      store,
      manager,
      storage,
      toolNameCacheStorage: createMemoryToolNameCacheStorage(),
      capabilities: { stdio: true },
      createId: () => ids[nextId++]!,
    })

    await expect(service.importJson(JSON.stringify({
      mcpServers: {
        playwright: {
          command: 'npx',
          args: ['@playwright/mcp@latest'],
        },
        search: {
          type: 'http',
          url: 'https://search.example.com/mcp',
        },
      },
    }))).resolves.toBe(true)

    const expected: readonly PersistedMcpServerConfig[] = [
      {
        id: 'local-playwright',
        name: 'playwright',
        transport: 'stdio',
        command: 'npx',
        args: ['@playwright/mcp@latest'],
        autoConnect: false,
      },
      {
        id: 'remote-search',
        name: 'search',
        transport: 'streamable-http',
        url: 'https://search.example.com/mcp',
        autoConnect: false,
      },
    ]
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(expected)
    expect(store.getter(mcpServerConfigsAtom)).toEqual(expected)
    // 安装即探测（B2）只覆盖 HTTP：远端服务连一次取回工具清单后立刻断开，
    // stdio 在 H2 的确认门上线前绝不起进程。两者都保持 autoConnect: false。
    await vi.waitFor(() => expect(manager.disconnectCalls).toEqual(['remote-search']))
    expect(manager.connectCalls.map((config) => config.id)).toEqual(['remote-search'])
    expect(store.getter(mcpServersAtom)).toEqual([
      expect.objectContaining({ id: 'local-playwright', status: 'disconnected' }),
      expect.objectContaining({ id: 'remote-search', status: 'disconnected' }),
    ])
  })

  it('rejects a case-insensitive name conflict without partially importing the batch', async () => {
    const existing: PersistedMcpServerConfig = {
      id: 'existing-search',
      name: 'Search',
      transport: 'streamable-http',
      url: 'https://existing.example.com/mcp',
      autoConnect: false,
    }
    const store = createStore()
    const { storage, save } = createStorage([existing])
    const service = createMcpSettingsService({ store, manager, storage })
    await service.hydrate()
    const configsBefore = store.getter(mcpServerConfigsAtom)
    const serversBefore = store.getter(mcpServersAtom)

    await expect(service.importJson(JSON.stringify({
      mcpServers: {
        docs: { url: 'https://docs.example.com/mcp' },
        search: { url: 'https://replacement.example.com/mcp' },
      },
    }))).resolves.toBe(false)

    expect(save).not.toHaveBeenCalled()
    expect(manager.connectCalls).toHaveLength(0)
    expect(store.getter(mcpServerConfigsAtom)).toEqual(configsBefore)
    expect(store.getter(mcpServersAtom)).toEqual(serversBefore)
    expect(store.getter(mcpFormErrorAtom)).toContain('同名')
  })

  it('keeps the existing state intact when the atomic import save fails', async () => {
    const existing: PersistedMcpServerConfig = {
      id: 'existing-docs',
      name: '已有文档',
      transport: 'streamable-http',
      url: 'https://existing.example.com/mcp',
      autoConnect: false,
    }
    const store = createStore()
    const { storage, save } = createStorage([existing])
    const service = createMcpSettingsService({ store, manager, storage })
    await service.hydrate()
    const configsBefore = store.getter(mcpServerConfigsAtom)
    const serversBefore = store.getter(mcpServersAtom)
    save.mockImplementation(() => {
      throw new Error('storage unavailable')
    })

    await expect(service.importJson(JSON.stringify({
      mcpServers: {
        imported: { url: 'https://imported.example.com/mcp' },
      },
    }))).resolves.toBe(false)

    expect(save).toHaveBeenCalledTimes(1)
    expect(manager.connectCalls).toHaveLength(0)
    expect(store.getter(mcpServerConfigsAtom)).toEqual(configsBefore)
    expect(store.getter(mcpServersAtom)).toEqual(serversBefore)
    expect(store.getter(mcpFormErrorAtom)).toContain('storage unavailable')
  })
})
