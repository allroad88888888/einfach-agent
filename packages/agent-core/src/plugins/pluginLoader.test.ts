import { describe, expect, it, vi } from 'vitest'
import { definePlugin } from '../runtime/core/pluginContracts'
import { createPluginHost } from '../runtime/core/pluginHost'
import { createToolRegistry } from '../tools/toolRegistry'
import { parsePluginManifest } from './manifest'
import { loadScannedPlugins } from './pluginLoader'
import { TOP_LEVEL_SIDE_EFFECT_TODO, type PluginLoaderDeps } from './pluginLoaderTypes'
import type { ScannedPlugin } from './pluginScanner'

const HOST_RANGE = { min: '1.0.0', max: '1.9.9' }

function scanned(dirName: string, overrides: Record<string, unknown> = {}): ScannedPlugin {
  const manifestResult = parsePluginManifest({
    id: `acme.${dirName}`,
    name: `${dirName} 插件`,
    version: '1.0.0',
    apiVersion: '1.2.0',
    capabilities: ['hooks'],
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

/** modules：入口路径 → 模块命名空间；值是函数时调用它（用于制造 import 抛错）。 */
function createDeps(
  modules: Record<string, unknown>,
  overrides: Partial<PluginLoaderDeps> = {},
): PluginLoaderDeps & { imported: string[] } {
  const imported: string[] = []
  const registry = createToolRegistry()
  return {
    imported,
    async importModule(entryPath) {
      imported.push(entryPath)
      const found = modules[entryPath]
      if (typeof found === 'function') return (found as () => unknown)()
      if (found === undefined) throw new Error(`ENOENT: ${entryPath}`)
      return found
    },
    host: createPluginHost(registry, []),
    apiVersionRange: HOST_RANGE,
    ...overrides,
  }
}

const emptyPlugin = () => ({ default: definePlugin({ install() {} }) })

describe('loadScannedPlugins 正常加载', () => {
  it('import → branded 校验 → 安装，产出 enabled 与 disposer', async () => {
    const installed = vi.fn()
    const deps = createDeps({
      '.webAgent/plugins/hello/core.js': { default: definePlugin({ install: installed }) },
    })

    const result = await loadScannedPlugins([scanned('hello')], deps)

    expect(deps.imported).toEqual(['.webAgent/plugins/hello/core.js'])
    expect(installed).toHaveBeenCalledTimes(1)
    expect(result.plugins).toHaveLength(1)
    expect(result.plugins[0]).toMatchObject({
      dirName: 'hello',
      id: 'acme.hello',
      name: 'hello 插件',
      version: '1.0.0',
      status: 'enabled',
      entryPath: '.webAgent/plugins/hello/core.js',
      grantedTools: [],
      withheldTools: [],
      deniedCapabilities: [],
    })
    expect(typeof result.plugins[0]?.dispose).toBe('function')
  })

  it('接受具名 corePlugin 导出，并把 top-level 副作用列为宿主保证的 TODO', async () => {
    const deps = createDeps({
      '.webAgent/plugins/hello/core.js': { corePlugin: definePlugin({ install() {} }) },
    })

    const result = await loadScannedPlugins([scanned('hello')], deps)

    expect(result.plugins[0]?.status).toBe('enabled')
    expect(result.unverified).toEqual([TOP_LEVEL_SIDE_EFFECT_TODO])
    expect(TOP_LEVEL_SIDE_EFFECT_TODO).toContain('TODO(top-level-side-effects)')
  })

  it('入口路径按 manifest 的 entry.core 拼，而不是固定文件名', async () => {
    const deps = createDeps({
      '.webAgent/plugins/hello/dist/index.mjs': emptyPlugin(),
    })

    const result = await loadScannedPlugins(
      [scanned('hello', { entry: { core: 'dist/index.mjs' } })],
      deps,
    )

    expect(result.plugins[0]?.status).toBe('enabled')
  })
})

describe('loadScannedPlugins 错误隔离', () => {
  it('单个插件 import 抛错只降级该项，其余照常加载', async () => {
    const deps = createDeps({
      '.webAgent/plugins/hello/core.js': emptyPlugin(),
      '.webAgent/plugins/broken/core.js': () => { throw new SyntaxError('Unexpected token') },
      '.webAgent/plugins/gamma/core.js': emptyPlugin(),
    })

    const result = await loadScannedPlugins(
      [scanned('hello'), scanned('broken'), scanned('gamma')],
      deps,
    )

    expect(result.plugins.map((plugin) => plugin.status)).toEqual(['enabled', 'failed', 'enabled'])
    expect(result.plugins[1]?.diagnostics.join('\n')).toContain('Unexpected token')
    expect(result.plugins[1]?.dispose).toBeUndefined()
    expect(result.plugins[1]?.entryPath).toBe('.webAgent/plugins/broken/core.js')
  })

  it('入口文件缺失记为 failed，不抛出', async () => {
    const deps = createDeps({})
    const result = await loadScannedPlugins([scanned('hello')], deps)

    expect(result.plugins[0]?.status).toBe('failed')
    expect(result.plugins[0]?.diagnostics.join('\n')).toContain('导入 .webAgent/plugins/hello/core.js 失败')
  })

  it('非 branded 导出一律拒绝', async () => {
    const deps = createDeps({
      '.webAgent/plugins/hello/core.js': { default: { install() {} } },
    })

    const result = await loadScannedPlugins([scanned('hello')], deps)

    expect(result.plugins[0]?.status).toBe('failed')
    expect(result.plugins[0]?.diagnostics.join('\n')).toContain('definePlugin')
  })

  it('既无默认导出也无 corePlugin 导出时拒绝', async () => {
    const deps = createDeps({ '.webAgent/plugins/hello/core.js': { other: 1 } })
    const result = await loadScannedPlugins([scanned('hello')], deps)

    expect(result.plugins[0]?.status).toBe('failed')
    expect(result.plugins[0]?.diagnostics.join('\n')).toContain('corePlugin')
  })

  it('扫描期就无效的项留在结果里并标 failed，诊断透传', async () => {
    const invalid = scanned('bad', { id: 'core.reserved' })
    const result = await loadScannedPlugins(
      [{ ...invalid, diagnostics: ['bad: id: 保留前缀'] }],
      createDeps({}),
    )

    expect(result.plugins[0]).toMatchObject({ dirName: 'bad', status: 'failed' })
    // manifest 没解析出来就没有身份，只能靠 dirName 定位。
    expect(result.plugins[0]?.id).toBeUndefined()
    expect(result.plugins[0]?.diagnostics).toContain('bad: id: 保留前缀')
    expect(result.plugins[0]?.diagnostics.join('\n')).toContain('manifest 无效')
  })

  it('两个目录认领同一个 id 时后者失败，前者不受影响', async () => {
    const deps = createDeps({
      '.webAgent/plugins/hello/core.js': emptyPlugin(),
      '.webAgent/plugins/copy/core.js': emptyPlugin(),
    })

    const result = await loadScannedPlugins(
      [scanned('hello'), scanned('copy', { id: 'acme.hello' })],
      deps,
    )

    expect(result.plugins.map((plugin) => plugin.status)).toEqual(['enabled', 'failed'])
    expect(result.plugins[1]?.diagnostics.join('\n')).toContain('与目录 hello 重复')
    expect(deps.imported).toEqual(['.webAgent/plugins/hello/core.js'])
  })
})

describe('loadScannedPlugins 兼容性分流', () => {
  it('apiVersion 超出宿主区间标 incompatible，且不 import', async () => {
    const deps = createDeps({ '.webAgent/plugins/hello/core.js': emptyPlugin() })

    const result = await loadScannedPlugins([scanned('hello', { apiVersion: '9.0.0' })], deps)

    expect(result.plugins[0]?.status).toBe('incompatible')
    expect(result.plugins[0]?.diagnostics.join('\n')).toContain('插件要求 API 9.0.0')
    expect(deps.imported).toEqual([])
  })

  it('只声明 react 入口的插件对 core 加载器是 incompatible', async () => {
    const deps = createDeps({})

    const result = await loadScannedPlugins(
      [scanned('hello', { entry: { react: 'ui.js' }, capabilities: ['renderer'] })],
      deps,
    )

    expect(result.plugins[0]?.status).toBe('incompatible')
    expect(result.plugins[0]?.diagnostics.join('\n')).toContain('未声明 core 入口')
    expect(deps.imported).toEqual([])
  })

  it('宿主区间自己配错时算 failed，不写在插件账上', async () => {
    const deps = createDeps(
      { '.webAgent/plugins/hello/core.js': emptyPlugin() },
      { apiVersionRange: { min: '2.0.0', max: '1.0.0' } },
    )

    const result = await loadScannedPlugins([scanned('hello')], deps)

    expect(result.plugins[0]?.status).toBe('failed')
    expect(result.plugins[0]?.diagnostics.join('\n')).toContain('宿主声明的 API 支持区间不合法')
  })
})
