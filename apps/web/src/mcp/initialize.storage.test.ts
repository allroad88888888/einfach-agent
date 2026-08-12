// 装配点选哪个存储后端（B1）：桌面宿主走 mcp_config_read / mcp_config_write，浏览器宿主走
// localStorage。
//
// 【为什么与 initialize.test.ts 分开】那边钉的是「缓存与占位一路走到模型面前」（B4/F4/F8/D3a），
// 全程只有一个宿主；这边钉的是「装配那一刻 isTauri() 答什么，读写就落到哪」，每个用例都要换一次
// 宿主。两者共用不了同一份 seed，也共用不了同一个已装配好的 service。
//
// 装配按 isMcpSettingsConfigured() 只生效一次，所以每个用例都先 vi.resetModules() 拿一套全新的
// 模块实例，再让它重新走一遍「读 isTauri() → 选 storage」。

import { describe, expect, it, vi } from 'vitest'
import { MCP_SETTINGS_STORAGE_KEY } from './persistence'

// 用可控的替身，但保持与真实模块一致的默认表现：isTauri() 默认 false、invoke 不被意外调用。
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}))

/** 换一套全新模块实例，并把共用的两个 mock 清干净（resetModules 不清替身的调用记录）。 */
async function freshHost(tauriHost: boolean) {
  vi.resetModules()
  const tauriCore = await import('@tauri-apps/api/core')
  const isTauriMock = vi.mocked(tauriCore.isTauri)
  const invokeMock = vi.mocked(tauriCore.invoke)
  isTauriMock.mockReset()
  invokeMock.mockReset()
  isTauriMock.mockReturnValue(tauriHost)
  return { isTauriMock, invokeMock }
}

describe('装配点接入桌面配置文件存储（B1）', () => {
  it('Tauri 宿主下，服务配置的读写都经 mcp_config_read / mcp_config_write，不落 localStorage', async () => {
    const { invokeMock } = await freshHost(true)

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

    initializeFresh()
    await hydrateFresh()

    expect(invokeMock).toHaveBeenCalledWith('mcp_config_read')
    // 装配读到的服务确实来自 mcp_config_read，不是 localStorage 里的旧数据。
    expect(window.localStorage.getItem(MCP_SETTINGS_STORAGE_KEY)).toBeNull()

    await removeFresh('remote-desktop')

    const writeCalls = invokeMock.mock.calls.filter(([command]) => command === 'mcp_config_write')
    expect(writeCalls).toContainEqual(['mcp_config_write', { patch: { servers: [] } }])
    // 全程没有一次写落到浏览器存储。
    expect(window.localStorage.getItem(MCP_SETTINGS_STORAGE_KEY)).toBeNull()
  })

  it('浏览器宿主下行为不变：装配仍走 localStorage 读写，不触碰 invoke', async () => {
    const { invokeMock } = await freshHost(false)

    window.localStorage.clear()
    // 与上一个用例对称：直接在 localStorage 里放一份既有配置，证明装配读到的是
    // 浏览器存储而不是 mcp_config_read。
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

    initializeFresh()
    await hydrateFresh()
    expect(invokeMock).not.toHaveBeenCalled()

    await removeFresh('browser-local')

    expect(invokeMock).not.toHaveBeenCalled()
    const stored = JSON.parse(window.localStorage.getItem(MCP_SETTINGS_STORAGE_KEY) ?? '{}')
    expect(stored.servers).toEqual([])
  })
})
