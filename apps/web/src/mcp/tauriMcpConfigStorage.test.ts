import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke, isTauri } from '@tauri-apps/api/core'
import type { PersistedMcpServerConfig } from './types'
import { createDesktopMcpConfigStorage, createTauriMcpConfigStorage } from './tauriMcpConfigStorage'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}))

const invokeMock = vi.mocked(invoke)
const isTauriMock = vi.mocked(isTauri)

function httpConfig(index: number): PersistedMcpServerConfig {
  return {
    id: `server-${index}`,
    name: `服务 ${index}`,
    transport: 'streamable-http',
    url: `https://example.com/mcp/${index}`,
    autoConnect: false,
  }
}

describe('Tauri-backed MCP config storage', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    isTauriMock.mockReset()
    isTauriMock.mockReturnValue(false)
    window.localStorage.clear()
  })

  describe('createDesktopMcpConfigStorage', () => {
    it('falls back to the existing localStorage implementation when no Tauri host is present', async () => {
      isTauriMock.mockReturnValue(false)
      const storage = createDesktopMcpConfigStorage()

      await storage.save([httpConfig(1)])
      const loaded = await storage.load()

      expect(loaded).toEqual([httpConfig(1)])
      expect(storage.persistence).toBe('persistent')
      expect(invokeMock).not.toHaveBeenCalled()
    })

    it('uses the Tauri config command channel when a Tauri host is present', async () => {
      isTauriMock.mockReturnValue(true)
      invokeMock.mockResolvedValueOnce({ servers: [httpConfig(1)] })
      const storage = createDesktopMcpConfigStorage()

      const loaded = await storage.load()

      expect(loaded).toEqual([httpConfig(1)])
      expect(invokeMock).toHaveBeenCalledWith('mcp_config_read')
    })
  })

  describe('createTauriMcpConfigStorage', () => {
    it('reads the servers key out of the mcp config section', async () => {
      invokeMock.mockResolvedValueOnce({ servers: [httpConfig(1), httpConfig(2)] })
      const storage = createTauriMcpConfigStorage()

      const loaded = await storage.load()

      expect(loaded).toEqual([httpConfig(1), httpConfig(2)])
      expect(invokeMock).toHaveBeenCalledTimes(1)
      expect(invokeMock).toHaveBeenCalledWith('mcp_config_read')
    })

    it('treats a missing section or missing servers key as an empty list', async () => {
      invokeMock.mockResolvedValueOnce({})
      const storage = createTauriMcpConfigStorage()

      expect(await storage.load()).toEqual([])
    })

    it('drops unsafe fields the same way the localStorage implementation does', async () => {
      invokeMock.mockResolvedValueOnce({
        servers: [
          {
            id: 'http',
            name: '远程',
            transport: 'streamable-http',
            url: 'https://example.com/mcp',
            autoConnect: true,
            headers: { Authorization: 'Bearer secret' },
          },
        ],
      })
      const storage = createTauriMcpConfigStorage()

      const loaded = await storage.load()

      expect(loaded).toEqual([{
        id: 'http',
        name: '远程',
        transport: 'streamable-http',
        url: 'https://example.com/mcp',
        autoConnect: true,
      }])
    })

    it('writes the sanitized configs under the servers key via mcp_config_write', async () => {
      invokeMock.mockResolvedValueOnce(undefined)
      const storage = createTauriMcpConfigStorage()

      await storage.save([httpConfig(1)])

      expect(invokeMock).toHaveBeenCalledWith('mcp_config_write', {
        patch: { servers: [httpConfig(1)] },
      })
    })

    it('rejects with a clear message when the servers field is malformed', async () => {
      invokeMock.mockResolvedValueOnce({ servers: 'not-an-array' })
      const storage = createTauriMcpConfigStorage()

      await expect(storage.load()).rejects.toThrow('servers 字段格式无效')
    })

    it('degrades a failed read into a normalized error instead of an unhandled rejection shape', async () => {
      invokeMock.mockRejectedValueOnce('模型配置文件格式无效')
      const storage = createTauriMcpConfigStorage()

      await expect(storage.load()).rejects.toThrow('无法读取 MCP 配置：模型配置文件格式无效')
    })

    it('degrades a failed write into a normalized error', async () => {
      invokeMock.mockRejectedValueOnce('mcp 配置段格式无效')
      const storage = createTauriMcpConfigStorage()

      await expect(storage.save([httpConfig(1)])).rejects.toThrow(
        '无法保存 MCP 配置：mcp 配置段格式无效',
      )
      expect(invokeMock).toHaveBeenCalledTimes(1)
    })

    it('still enforces the persisted server limit before ever calling the command', async () => {
      const storage = createTauriMcpConfigStorage()
      const configs = Array.from({ length: 51 }, (_, index) => httpConfig(index))

      await expect(storage.save(configs)).rejects.toThrow('最多只能配置 50 个')
      expect(invokeMock).not.toHaveBeenCalled()
    })
  })
})
