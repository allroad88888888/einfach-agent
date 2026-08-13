import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_PLUGIN_DIRS,
  scanPlugins,
  type PluginScanBridge,
} from './pluginScanner'

type FileEntry = { path: string; type: string }

/** 内存 bridge：entries 描述目录树，files 是路径 → 文本内容；未列出的路径读取即 ENOENT。 */
function createBridge(entries: FileEntry[], files: Record<string, string>): PluginScanBridge {
  return {
    async listFiles(path) {
      const prefix = `${path}/`
      return {
        entries: entries.filter((entry) =>
          entry.path.startsWith(prefix) && !entry.path.slice(prefix.length).includes('/'),
        ),
      }
    },
    async readFile(path) {
      const content = files[path]
      if (content === undefined) throw new Error(`ENOENT: ${path}`)
      return { content }
    },
  }
}

const validManifestJson = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  id: 'acme.hello',
  name: 'Hello 插件',
  version: '1.0.0',
  apiVersion: '1.0.0',
  capabilities: ['hooks'],
  entry: { core: 'core.js' },
  ...overrides,
})

describe('scanPlugins 目录不存在', () => {
  it('插件根目录不存在时返回空数组、零诊断', async () => {
    const bridge: PluginScanBridge = {
      async listFiles() {
        throw new Error('path is not accessible: missing')
      },
      async readFile() {
        throw new Error('unused')
      },
    }
    const result = await scanPlugins('/workspace', bridge)
    expect(result).toEqual({ plugins: [], diagnostics: [] })
  })

  it('列目录因其他原因失败时返回空数组 + 一条扫描级诊断', async () => {
    const bridge: PluginScanBridge = {
      async listFiles() {
        throw new Error('permission denied')
      },
      async readFile() {
        throw new Error('unused')
      },
    }
    const result = await scanPlugins('/workspace', bridge)
    expect(result.plugins).toEqual([])
    expect(result.diagnostics).toEqual(['.webAgent/plugins: 列表失败 — permission denied'])
  })
})

describe('scanPlugins 合法插件', () => {
  it('单文件插件（plugin.json）扫描为 discovered', async () => {
    const entries: FileEntry[] = [{ path: '.webAgent/plugins/hello', type: 'directory' }]
    const files = { '.webAgent/plugins/hello/plugin.json': validManifestJson() }
    const result = await scanPlugins('/workspace', createBridge(entries, files))

    expect(result.diagnostics).toEqual([])
    expect(result.plugins).toHaveLength(1)
    expect(result.plugins[0]).toMatchObject({
      dirName: 'hello',
      status: 'discovered',
      manifestSource: 'plugin.json',
      diagnostics: [],
    })
    expect(result.plugins[0]?.manifestResult?.ok).toBe(true)
  })

  it('包插件（package.json 的 webAgent 字段）扫描为 discovered', async () => {
    const entries: FileEntry[] = [{ path: '.webAgent/plugins/pkg', type: 'directory' }]
    const files = {
      '.webAgent/plugins/pkg/package.json': JSON.stringify({
        name: 'pkg-example',
        webAgent: JSON.parse(validManifestJson({ id: 'acme.pkg' })),
      }),
    }
    const result = await scanPlugins('/workspace', createBridge(entries, files))

    expect(result.plugins).toHaveLength(1)
    expect(result.plugins[0]).toMatchObject({
      dirName: 'pkg',
      status: 'discovered',
      manifestSource: 'package.json',
    })
    expect(result.plugins[0]?.manifestResult?.ok && result.plugins[0].manifestResult.manifest.id)
      .toBe('acme.pkg')
  })

  it('plugin.json 优先于同目录下的 package.json', async () => {
    const entries: FileEntry[] = [{ path: '.webAgent/plugins/both', type: 'directory' }]
    const files = {
      '.webAgent/plugins/both/plugin.json': validManifestJson({ id: 'acme.plugin-json' }),
      '.webAgent/plugins/both/package.json': JSON.stringify({
        webAgent: JSON.parse(validManifestJson({ id: 'acme.package-json' })),
      }),
    }
    const result = await scanPlugins('/workspace', createBridge(entries, files))

    expect(result.plugins[0]?.manifestSource).toBe('plugin.json')
    expect(result.plugins[0]?.manifestResult?.ok && result.plugins[0].manifestResult.manifest.id)
      .toBe('acme.plugin-json')
  })

  it('单目录坏不影响其余目录', async () => {
    const entries: FileEntry[] = [
      { path: '.webAgent/plugins/good', type: 'directory' },
      { path: '.webAgent/plugins/bad', type: 'directory' },
    ]
    const files = {
      '.webAgent/plugins/good/plugin.json': validManifestJson({ id: 'acme.good' }),
      '.webAgent/plugins/bad/plugin.json': '{not json',
    }
    const result = await scanPlugins('/workspace', createBridge(entries, files))

    const good = result.plugins.find((plugin) => plugin.dirName === 'good')
    const bad = result.plugins.find((plugin) => plugin.dirName === 'bad')
    expect(good?.status).toBe('discovered')
    expect(bad?.status).toBe('invalid')
  })
})

describe('scanPlugins 坏输入', () => {
  it('两种形状都缺失时该项 invalid，记录未找到两种文件', async () => {
    const entries: FileEntry[] = [{ path: '.webAgent/plugins/empty', type: 'directory' }]
    const result = await scanPlugins('/workspace', createBridge(entries, {}))

    expect(result.plugins).toEqual([{
      dirName: 'empty',
      status: 'invalid',
      diagnostics: ['empty: 未找到 plugin.json，也未找到 package.json'],
    }])
  })

  it('plugin.json 是坏 JSON 时该项 invalid，不回退到 package.json', async () => {
    const entries: FileEntry[] = [{ path: '.webAgent/plugins/broken', type: 'directory' }]
    const files = {
      '.webAgent/plugins/broken/plugin.json': '{ "id": ',
      '.webAgent/plugins/broken/package.json': JSON.stringify({
        webAgent: JSON.parse(validManifestJson()),
      }),
    }
    const result = await scanPlugins('/workspace', createBridge(entries, files))

    expect(result.plugins[0]?.status).toBe('invalid')
    expect(result.plugins[0]?.manifestSource).toBe('plugin.json')
    expect(result.plugins[0]?.manifestResult).toBeUndefined()
    expect(result.plugins[0]?.diagnostics[0]).toContain('JSON 解析失败')
  })

  it('package.json 缺少 webAgent 字段时该项 invalid', async () => {
    const entries: FileEntry[] = [{ path: '.webAgent/plugins/nofield', type: 'directory' }]
    const files = { '.webAgent/plugins/nofield/package.json': JSON.stringify({ name: 'x' }) }
    const result = await scanPlugins('/workspace', createBridge(entries, files))

    expect(result.plugins[0]).toMatchObject({
      dirName: 'nofield',
      status: 'invalid',
      manifestSource: 'package.json',
    })
    expect(result.plugins[0]?.diagnostics[0]).toContain('缺少 `webAgent` 字段')
  })

  it('manifest 字段非法时该项 invalid 并透出诊断文案', async () => {
    const entries: FileEntry[] = [{ path: '.webAgent/plugins/badfields', type: 'directory' }]
    const files = {
      '.webAgent/plugins/badfields/plugin.json': JSON.stringify({ id: 'Not Valid' }),
    }
    const result = await scanPlugins('/workspace', createBridge(entries, files))

    expect(result.plugins[0]?.status).toBe('invalid')
    expect(result.plugins[0]?.manifestResult?.ok).toBe(false)
    expect(result.plugins[0]?.diagnostics.some((line) => line.startsWith('badfields:'))).toBe(true)
    expect(result.plugins[0]?.diagnostics.length).toBeGreaterThan(0)
  })

  it('manifest 解析成功但有警告时仍是 discovered，警告透出到 diagnostics', async () => {
    const entries: FileEntry[] = [{ path: '.webAgent/plugins/warns', type: 'directory' }]
    const files = {
      '.webAgent/plugins/warns/plugin.json': validManifestJson({
        capabilities: ['hooks', 'timeline.persist'],
      }),
    }
    const result = await scanPlugins('/workspace', createBridge(entries, files))

    expect(result.plugins[0]?.status).toBe('discovered')
    expect(result.plugins[0]?.diagnostics[0]).toContain('timeline.persist')
  })

  it('bridge 读 plugin.json 失败（非缺失）时该项 invalid，记录真实错误', async () => {
    const entries: FileEntry[] = [{ path: '.webAgent/plugins/denied', type: 'directory' }]
    const bridge: PluginScanBridge = {
      async listFiles(path) {
        const prefix = `${path}/`
        return { entries: entries.filter((entry) => entry.path.startsWith(prefix)) }
      },
      async readFile(path) {
        if (path.endsWith('plugin.json')) throw new Error('EACCES: permission denied')
        throw new Error(`ENOENT: ${path}`)
      },
    }
    const result = await scanPlugins('/workspace', bridge)

    expect(result.plugins[0]).toMatchObject({ dirName: 'denied', status: 'invalid', manifestSource: 'plugin.json' })
    expect(result.plugins[0]?.diagnostics[0]).toContain('EACCES: permission denied')
  })
})

describe('scanPlugins 子目录数上限', () => {
  it('超过默认上限时截断，按目录名排序保留前 N 个并记诊断', async () => {
    const totalDirs = DEFAULT_MAX_PLUGIN_DIRS + 5
    const entries: FileEntry[] = Array.from({ length: totalDirs }, (_, index) => ({
      path: `.webAgent/plugins/p${String(index).padStart(3, '0')}`,
      type: 'directory',
    }))
    const files: Record<string, string> = {}
    for (const entry of entries) {
      files[`${entry.path}/plugin.json`] = validManifestJson({ id: `acme.${entry.path.split('/').pop()}` })
    }

    const result = await scanPlugins('/workspace', createBridge(entries, files))

    expect(result.plugins).toHaveLength(DEFAULT_MAX_PLUGIN_DIRS)
    expect(result.plugins.map((plugin) => plugin.dirName)).toEqual(
      Array.from({ length: DEFAULT_MAX_PLUGIN_DIRS }, (_, index) => `p${String(index).padStart(3, '0')}`),
    )
    expect(result.diagnostics).toEqual([
      `.webAgent/plugins: 子目录数 ${totalDirs} 超过上限 ${DEFAULT_MAX_PLUGIN_DIRS}，已截断`,
    ])
  })

  it('可通过 options.maxPluginDirs 自定义上限', async () => {
    const entries: FileEntry[] = [
      { path: '.webAgent/plugins/a', type: 'directory' },
      { path: '.webAgent/plugins/b', type: 'directory' },
      { path: '.webAgent/plugins/c', type: 'directory' },
    ]
    const files: Record<string, string> = {}
    for (const entry of entries) {
      files[`${entry.path}/plugin.json`] = validManifestJson({ id: `acme.${entry.path.split('/').pop()}` })
    }

    const result = await scanPlugins('/workspace', createBridge(entries, files), { maxPluginDirs: 2 })

    expect(result.plugins.map((plugin) => plugin.dirName)).toEqual(['a', 'b'])
    expect(result.diagnostics).toEqual(['.webAgent/plugins: 子目录数 3 超过上限 2，已截断'])
  })
})

describe('scanPlugins 忽略非目录条目', () => {
  it('插件根目录下的普通文件不会被当成插件目录', async () => {
    const entries: FileEntry[] = [
      { path: '.webAgent/plugins/README.md', type: 'file' },
      { path: '.webAgent/plugins/hello', type: 'directory' },
    ]
    const files = { '.webAgent/plugins/hello/plugin.json': validManifestJson() }
    const result = await scanPlugins('/workspace', createBridge(entries, files))

    expect(result.plugins).toHaveLength(1)
    expect(result.plugins[0]?.dirName).toBe('hello')
  })
})
