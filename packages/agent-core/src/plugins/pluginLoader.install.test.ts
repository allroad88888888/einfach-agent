// 加载器的安装侧端到端：工具闸门（拍板 3）、timeline.persist 拒绝（R5 未批）、
// 安装期预检失败的原子回滚，以及 disposer 卸载后无残留。
// 这里用真实的 createPluginHost + createToolRegistry，不用 fake——闸门与卸载的判据都在真实注册表上。

import { createStore } from '@einfach/core'
import { describe, expect, it, vi } from 'vitest'
import { definePlugin } from '../runtime/core/pluginContracts'
import { createPluginHost, type PluginHost } from '../runtime/core/pluginHost'
import { createToolRegistry, type ToolRegistry } from '../tools/toolRegistry'
import type { Tool } from '../tools/types'
import { parsePluginManifest } from './manifest'
import { loadScannedPlugins } from './pluginLoader'
import type { PluginLoaderDeps } from './pluginLoaderTypes'
import type { ScannedPlugin } from './pluginScanner'

function scanned(dirName: string, overrides: Record<string, unknown> = {}): ScannedPlugin {
  const manifestResult = parsePluginManifest({
    id: `acme.${dirName}`,
    name: `${dirName} 插件`,
    version: '1.0.0',
    apiVersion: '1.0.0',
    capabilities: ['tools'],
    entry: { core: 'core.js' },
    ...overrides,
  })
  return {
    dirName,
    status: manifestResult.ok ? 'discovered' : 'invalid',
    manifestSource: 'plugin.json',
    manifestResult,
    diagnostics: [],
  }
}

function probeTool(name: string, extra: Partial<Tool> = {}): Tool {
  return {
    name,
    runtime: 'internal',
    skill: { description: name, content: name },
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ ok: true }),
    ...extra,
  }
}

function createHarness(
  modules: Record<string, unknown>,
  isToolEnabled?: (pluginId: string, toolName: string) => boolean,
): PluginLoaderDeps & { registry: ToolRegistry; host: PluginHost } {
  const registry = createToolRegistry()
  const host = createPluginHost(registry, [])
  return {
    registry,
    host,
    apiVersionRange: { min: '1.0.0', max: '1.9.9' },
    ...(isToolEnabled ? { isToolEnabled } : {}),
    async importModule(entryPath) {
      const found = modules[entryPath]
      if (found === undefined) throw new Error(`ENOENT: ${entryPath}`)
      return found
    },
  }
}

const ENTRY = '.webAgent/plugins/hello/core.js'

describe('模型可见工具闸门（拍板 3）', () => {
  it('默认不注册插件声明的模型可见工具', async () => {
    const deps = createHarness({
      [ENTRY]: {
        default: definePlugin({
          install(api) { api.registerTool(probeTool('acme_probe')) },
        }),
      },
    })

    const result = await loadScannedPlugins([scanned('hello')], deps)

    expect(result.plugins[0]?.status).toBe('enabled')
    expect(result.plugins[0]?.grantedTools).toEqual([])
    expect(result.plugins[0]?.withheldTools).toEqual(['acme_probe'])
    expect(result.plugins[0]?.diagnostics.join('\n')).toContain('默认未启用')
    expect(deps.registry.has('acme_probe')).toBe(false)
    expect(deps.registry.list().map((tool) => tool.name)).toEqual([])
  })

  it('勾选后同一条路径正常注册并对模型可见', async () => {
    const deps = createHarness(
      {
        [ENTRY]: {
          default: definePlugin({
            install(api) {
              api.registerTool(probeTool('acme_probe'))
              api.registerTool(probeTool('acme_other'))
            },
          }),
        },
      },
      (pluginId, toolName) => pluginId === 'acme.hello' && toolName === 'acme_probe',
    )

    const result = await loadScannedPlugins([scanned('hello')], deps)

    expect(result.plugins[0]?.grantedTools).toEqual(['acme_probe'])
    expect(result.plugins[0]?.withheldTools).toEqual(['acme_other'])
    expect(deps.registry.list().map((tool) => tool.name)).toEqual(['acme_probe'])
    expect(deps.registry.loadSchema('acme_probe')).toBeDefined()
  })

  it('到点工具不属于模型可见面，不经勾选也照常注册', async () => {
    const deps = createHarness({
      [ENTRY]: {
        default: definePlugin({
          install(api) { api.registerTool(probeTool('acme_timed', { callTiming: 'runStart' })) },
        }),
      },
    })

    const result = await loadScannedPlugins([scanned('hello')], deps)

    expect(result.plugins[0]?.grantedTools).toEqual(['acme_timed'])
    expect(deps.registry.has('acme_timed')).toBe(true)
    // 到点工具本来就不进模型发现面。
    expect(deps.registry.list()).toEqual([])
  })
})

describe('timeline.persist 一律拒绝授予（R5 未批）', () => {
  it('记为 deniedCapabilities 且安装面上没有对应能力', async () => {
    const seenApiKeys: string[][] = []
    const deps = createHarness({
      [ENTRY]: {
        default: definePlugin({
          install(api) { seenApiKeys.push(Object.keys(api)) },
        }),
      },
    })

    const result = await loadScannedPlugins(
      [scanned('hello', { capabilities: ['hooks', 'timeline.persist'] })],
      deps,
    )

    expect(result.plugins[0]?.status).toBe('enabled')
    expect(result.plugins[0]?.deniedCapabilities).toEqual(['timeline.persist'])
    expect(result.plugins[0]?.diagnostics.join('\n')).toContain('已拒绝授予 timeline.persist')
    // 授予与否不是文案问题：安装 API 上根本没有该面，只有 registerTool。
    expect(seenApiKeys).toEqual([['registerTool']])
  })
})

describe('安装期预检失败的隔离', () => {
  it('工具重名的插件降级为 failed，先装好的插件不受影响', async () => {
    const deps = createHarness(
      {
        [ENTRY]: {
          default: definePlugin({ install(api) { api.registerTool(probeTool('acme_dup')) } }),
        },
        '.webAgent/plugins/beta/core.js': {
          default: definePlugin({ install(api) { api.registerTool(probeTool('acme_dup')) } }),
        },
      },
      () => true,
    )

    const result = await loadScannedPlugins([scanned('hello'), scanned('beta')], deps)

    expect(result.plugins.map((plugin) => plugin.status)).toEqual(['enabled', 'failed'])
    expect(result.plugins[1]?.diagnostics.join('\n')).toContain('安装失败')
    expect(result.plugins[1]?.grantedTools).toEqual([])
    expect(deps.registry.has('acme_dup')).toBe(true)
    expect(deps.registry.list()).toHaveLength(1)
  })
})

describe('disposer 卸载无残留', () => {
  it('卸载后工具注销、install disposer 触发、后续 run 不再激活该插件', async () => {
    const disposed = vi.fn()
    const activated = vi.fn()
    const deps = createHarness(
      {
        [ENTRY]: {
          default: definePlugin({
            install(api) {
              api.registerTool(probeTool('acme_probe'))
              return disposed
            },
            activate: activated,
          }),
        },
      },
      () => true,
    )

    const result = await loadScannedPlugins([scanned('hello')], deps)
    const loaded = result.plugins[0]
    expect(deps.registry.has('acme_probe')).toBe(true)

    const firstRun = await deps.host.activateRun(createStore())
    expect(activated).toHaveBeenCalledTimes(1)
    firstRun.dispose()

    loaded?.dispose?.()

    expect(disposed).toHaveBeenCalledTimes(1)
    expect(deps.registry.has('acme_probe')).toBe(false)
    expect(deps.registry.list()).toEqual([])

    const secondRun = await deps.host.activateRun(createStore())
    expect(activated).toHaveBeenCalledTimes(1)
    secondRun.dispose()

    // 幂等：重复卸载不再触发 disposer，也不抛。
    loaded?.dispose?.()
    expect(disposed).toHaveBeenCalledTimes(1)
  })

  it('host.dispose 会连带卸载动态安装的插件', async () => {
    const disposed = vi.fn()
    const deps = createHarness(
      {
        [ENTRY]: {
          default: definePlugin({
            install(api) {
              api.registerTool(probeTool('acme_probe'))
              return disposed
            },
          }),
        },
      },
      () => true,
    )

    await loadScannedPlugins([scanned('hello')], deps)
    expect(deps.registry.has('acme_probe')).toBe(true)

    deps.host.dispose()

    expect(disposed).toHaveBeenCalledTimes(1)
    expect(deps.registry.has('acme_probe')).toBe(false)
  })
})
