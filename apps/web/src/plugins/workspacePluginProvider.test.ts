// 桌面 provider 的加载语义（P10）：扫 `.webAgent/plugins/` → 按闸门装进 plugin host。
//
// 用内存 bridge + 注入的 importModule 驱动，因此跑的是真的 scanPlugins 与真的
// loadScannedPlugins，只有「怎么读盘」「怎么求值」两处换成替身——blob 求值那半截在
// pluginImportModule.test.ts，装配（谁在什么时候造 provider）在 initialize.test.ts。

import { createCore, definePlugin } from '@einfach-agent/core/plugin'
import type { PluginScanBridge } from '@einfach-agent/core'
import { describe, expect, it, vi } from 'vitest'
import { createWorkspacePluginSettingsProvider } from './workspacePluginProvider'

const WORKSPACE_ROOT = '/workspace/project'
const PLUGINS_DIR = '.webAgent/plugins'

const denyAllTools = () => false

function manifest(dirName: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: `acme.${dirName}`,
    name: `${dirName} 插件`,
    version: '1.0.0',
    apiVersion: '1.0.0',
    capabilities: ['hooks'],
    entry: { core: 'core.js' },
    ...overrides,
  })
}

/**
 * 内存文件系统桥。形状与生产用的 ProjectSkillsLoaderBridge 一致（PluginScanBridge 就是照它
 * 定的），失败按 workspaceRead 的口径抛错——scanPlugins 靠错误文本区分「不存在」与「读失败」。
 */
function memoryBridge(files: Record<string, string>, listError?: string): PluginScanBridge {
  return {
    async listFiles(path) {
      if (listError) throw new Error(listError)
      const prefix = `${path}/`
      const dirs = new Set<string>()
      for (const filePath of Object.keys(files)) {
        if (!filePath.startsWith(prefix)) continue
        const [dirName] = filePath.slice(prefix.length).split('/')
        if (dirName) dirs.add(`${path}/${dirName}`)
      }
      return { entries: [...dirs].map((dirPath) => ({ path: dirPath, type: 'directory' })) }
    },
    async readFile(path) {
      const content = files[path]
      if (content === undefined) throw new Error(`read_workspace_file failed: ENOENT ${path}`)
      return { content }
    },
  }
}

function pluginHost() {
  return createCore().plugins
}

describe('createWorkspacePluginSettingsProvider', () => {
  it('扫描并加载插件目录：入口路径按 dirName 拼，装进注入的 plugin host', async () => {
    const install = vi.fn()
    const importModule = vi.fn(async () => ({ default: definePlugin({ install }) }))
    const provider = createWorkspacePluginSettingsProvider({
      workspaceRoot: WORKSPACE_ROOT,
      bridge: memoryBridge({ [`${PLUGINS_DIR}/hello/plugin.json`]: manifest('hello') }),
      importModule,
      host: pluginHost(),
    })

    expect(provider.capabilities).toEqual({ supported: true })
    const result = await provider.load(denyAllTools)

    expect(importModule).toHaveBeenCalledWith(`${PLUGINS_DIR}/hello/core.js`)
    expect(install).toHaveBeenCalledTimes(1)
    expect(result.plugins).toHaveLength(1)
    expect(result.plugins[0]).toMatchObject({
      dirName: 'hello',
      id: 'acme.hello',
      status: 'enabled',
      entryPath: `${PLUGINS_DIR}/hello/core.js`,
    })
    expect(typeof result.plugins[0]?.dispose).toBe('function')
  })

  it('坏插件不拖垮好插件：manifest 非法的目录只是自己 failed', async () => {
    const provider = createWorkspacePluginSettingsProvider({
      workspaceRoot: WORKSPACE_ROOT,
      bridge: memoryBridge({
        [`${PLUGINS_DIR}/good/plugin.json`]: manifest('good'),
        [`${PLUGINS_DIR}/broken/plugin.json`]: '{ 这不是 JSON',
      }),
      importModule: async () => ({ default: definePlugin({ install() {} }) }),
      host: pluginHost(),
    })

    const result = await provider.load(denyAllTools)

    expect(result.plugins.map((item) => [item.dirName, item.status])).toEqual([
      ['broken', 'failed'],
      ['good', 'enabled'],
    ])
  })

  it('插件根目录不存在：空清单、零诊断，不当作错误', async () => {
    const provider = createWorkspacePluginSettingsProvider({
      workspaceRoot: WORKSPACE_ROOT,
      bridge: memoryBridge({}, 'list_workspace_files failed: ENOENT'),
      importModule: async () => ({}),
      host: pluginHost(),
    })

    await expect(provider.load(denyAllTools)).resolves.toEqual({
      plugins: [],
      unverified: expect.any(Array),
    })
  })

  it('列目录真失败：抛出让面板落到错误态，而不是谎称"还没有插件"', async () => {
    const provider = createWorkspacePluginSettingsProvider({
      workspaceRoot: WORKSPACE_ROOT,
      bridge: memoryBridge({}, 'list_workspace_files failed: EACCES'),
      importModule: async () => ({}),
      host: pluginHost(),
    })

    await expect(provider.load(denyAllTools)).rejects.toThrow('EACCES')
  })

  it('还没有 workspace root：空清单，且一次盘都不读（宿主仍然支持插件）', async () => {
    const bridge = memoryBridge({ [`${PLUGINS_DIR}/hello/plugin.json`]: manifest('hello') })
    const listFiles = vi.spyOn(bridge, 'listFiles')
    const provider = createWorkspacePluginSettingsProvider({
      bridge,
      importModule: async () => ({}),
      host: pluginHost(),
    })

    expect(provider.capabilities).toEqual({ supported: true })
    await expect(provider.load(denyAllTools)).resolves.toMatchObject({ plugins: [] })
    expect(listFiles).not.toHaveBeenCalled()
  })

  it('enable：重新扫一遍再只装那一个目录，勾选闸门原样透传给 loader', async () => {
    const gate = vi.fn((_pluginId: string, _toolName: string) => false)
    const provider = createWorkspacePluginSettingsProvider({
      workspaceRoot: WORKSPACE_ROOT,
      bridge: memoryBridge({
        [`${PLUGINS_DIR}/hello/plugin.json`]: manifest('hello', { capabilities: ['hooks', 'tools'] }),
        [`${PLUGINS_DIR}/other/plugin.json`]: manifest('other'),
      }),
      importModule: async () => ({
        default: definePlugin({
          install(api) {
            api.registerTool({
              name: 'acme_hello_ping',
              runtime: 'internal',
              skill: { description: 'ping', content: 'ping' },
              inputSchema: { type: 'object', properties: {} },
              execute: async () => ({ ok: true }),
            })
          },
        }),
      }),
      host: pluginHost(),
    })

    const loaded = await provider.enable('hello', gate)

    expect(loaded).toMatchObject({ dirName: 'hello', id: 'acme.hello', status: 'enabled' })
    // 闸门答 false ⇒ 工具被拦下，正是拍板 3 的"默认关"。
    expect(loaded.withheldTools).toEqual(['acme_hello_ping'])
    expect(gate).toHaveBeenCalledWith('acme.hello', 'acme_hello_ping')
  })

  it('enable：目录已经不在了 → failed 结果而不是抛异常（provider 的错误隔离约定）', async () => {
    const provider = createWorkspacePluginSettingsProvider({
      workspaceRoot: WORKSPACE_ROOT,
      bridge: memoryBridge({}),
      importModule: async () => ({}),
      host: pluginHost(),
    })

    const loaded = await provider.enable('gone', denyAllTools)

    expect(loaded.status).toBe('failed')
    expect(loaded.diagnostics.join('')).toContain('.webAgent/plugins/')
  })
})
