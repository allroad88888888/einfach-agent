import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { loadCliPlugins } from './plugins'

// 临时工作区必须落在仓库内（本文件所在目录下）：`good` fixture 会 import
// `@einfach-agent/core/plugin`，Node 的裸说明符解析要沿目录链向上找
// node_modules——只有落在仓库树内才能找到 workspace 符号链接（node_modules/@einfach-agent/core）。
const here = dirname(fileURLToPath(import.meta.url))
let workspaceRoot: string | undefined

afterEach(async () => {
  if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true })
  workspaceRoot = undefined
})

async function writePluginDir(
  root: string,
  dirName: string,
  files: Record<string, string>,
): Promise<void> {
  const dir = join(root, '.webAgent/plugins', dirName)
  await mkdir(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, 'utf8')
  }
}

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'acme.hello',
    name: 'Hello 插件',
    version: '1.0.0',
    apiVersion: '1.0.0',
    capabilities: [],
    entry: { core: 'core.mjs' },
    ...overrides,
  })
}

describe('loadCliPlugins', () => {
  it('合法单文件插件加载为 enabled，坏插件降级为 failed，互不影响', async () => {
    workspaceRoot = join(here, `.tmp-plugin-fixture-${Date.now()}`)
    await writePluginDir(workspaceRoot, 'good', {
      'plugin.json': manifest({ id: 'acme.good' }),
      'core.mjs': [
        "import { definePlugin } from '@einfach-agent/core/plugin'",
        'export default definePlugin({ install() {} })',
        '',
      ].join('\n'),
    })
    await writePluginDir(workspaceRoot, 'bad', {
      'plugin.json': manifest({ id: 'acme.bad' }),
      'core.mjs': "throw new Error('fixture: 故意在导入期抛错')\n",
    })

    const result = await loadCliPlugins(workspaceRoot)

    expect(result.load.plugins).toHaveLength(2)
    const good = result.load.plugins.find((plugin) => plugin.dirName === 'good')
    const bad = result.load.plugins.find((plugin) => plugin.dirName === 'bad')
    expect(good).toMatchObject({ status: 'enabled', id: 'acme.good' })
    expect(typeof good?.dispose).toBe('function')
    expect(bad).toMatchObject({ status: 'failed', id: 'acme.bad' })
    expect(bad?.diagnostics.some((line) => line.includes('导入'))).toBe(true)

    good?.dispose?.()
  })

  it('manifest 非法的插件降级为 failed，不影响启动', async () => {
    workspaceRoot = join(here, `.tmp-plugin-fixture-${Date.now()}-invalid`)
    await writePluginDir(workspaceRoot, 'broken-manifest', {
      'plugin.json': JSON.stringify({ id: '不是合法id' }),
    })

    const result = await loadCliPlugins(workspaceRoot)

    expect(result.load.plugins).toHaveLength(1)
    expect(result.load.plugins[0]).toMatchObject({ dirName: 'broken-manifest', status: 'failed' })
  })

  it('没有 .webAgent/plugins 目录时静默返回空结果', async () => {
    workspaceRoot = join(here, `.tmp-plugin-fixture-${Date.now()}-empty`)
    await mkdir(workspaceRoot, { recursive: true })

    const result = await loadCliPlugins(workspaceRoot)

    expect(result.load.plugins).toEqual([])
    expect(result.scanDiagnostics).toEqual([])
  })
})
