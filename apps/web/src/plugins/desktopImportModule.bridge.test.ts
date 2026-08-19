// P11 判据：quickstart 那种写裸说明符的插件，在桌面这条链路上真的能走到 enabled。
//
// 除「求值」一步外全是生产实现：真的 scanPlugins（内存文件桥）、真的 loadScannedPlugins、
// 真的说明符改写、真的契约模块桥。jsdom 不求值 blob 模块，所以这里放一个只认本文件会生成的
// 两种形状（`import {…} from 'blob:…'` / `export {…}` / `export default …`）的极小求值器——
// 它不是 bundler，只是把「blob URL → 模块命名空间」这一步在 jsdom 里补上。

import { loadScannedPlugins, scanPlugins, type PluginScanBridge } from '@einfach-agent/core'
import { createCore } from '@einfach-agent/core/plugin'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createContractModuleBridge } from './contractModuleBridge'
import { createDesktopImportModule } from './desktopImportModule'

const { readWorkspaceFileMock } = vi.hoisted(() => ({ readWorkspaceFileMock: vi.fn() }))

// 局部 mock：只替 readWorkspaceFile，其余原样保留——契约模块桥把整个 runtime 拉进了模块图。
vi.mock('@einfach-agent/core/runtime/workspaceRead', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readWorkspaceFile: readWorkspaceFileMock,
}))

const WORKSPACE_ROOT = '/workspace/project'
const PLUGINS_DIR = '.webAgent/plugins'
const HOST_API_VERSION_RANGE = { min: '1.0.0', max: '1.0.0' } as const

/** 与 docs/plugin-quickstart.md 第 3 步逐字同形：裸说明符 + definePlugin + registerTool。 */
const PLUGIN_ENTRY = `import { definePlugin } from '@einfach-agent/core/plugin'

export default definePlugin({
  install(api) {
    api.registerTool({
      name: 'hello_from_plugin',
      runtime: 'internal',
      skill: { description: '返回一句问候。', content: '# hello_from_plugin' },
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return { ok: true, data: { message: 'hello' } }
      },
    })
  },
})
`

const MANIFEST = JSON.stringify({
  id: 'acme.hello',
  name: 'Hello 插件',
  version: '1.0.0',
  apiVersion: '1.0.0',
  capabilities: ['tools'],
  entry: { core: 'plugin.mjs' },
})

const scanBridge: PluginScanBridge = {
  async listFiles(path) {
    return { entries: [{ path: `${path}/hello`, type: 'directory' }] }
  },
  async readFile(path) {
    if (path === `${PLUGINS_DIR}/hello/plugin.json`) return { content: MANIFEST }
    throw new Error(`read_workspace_file failed: ENOENT ${path}`)
  },
}

/** blob 表跨用例保留：默认契约桥是全应用单例，它的 URL 造过一次就一直被引用。 */
const blobs = new Map<string, Blob>()
let created: string[] = []

/** jsdom 的 Blob 没有 text()，用 FileReader 取字节——生产代码那半截不受影响。 */
function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

/** 极小 ESM 求值器：只处理本文件链路会生成的语句形状，够证明「桥接起来的模块真的能用」。 */
async function evaluateBlobModule(url: string): Promise<Record<string, unknown>> {
  const blob = blobs.get(url)
  if (!blob) throw new Error(`未知的 blob URL ${url}`)
  const source = await blobText(blob)

  const deps: Record<string, Record<string, unknown>> = {}
  for (const match of source.matchAll(/from\s*['"](blob:[^'"]+)['"]/g)) {
    deps[match[1]] = await evaluateBlobModule(match[1])
  }

  const body = source
    .replace(/^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?$/gm, (_m, clause: string, from: string) =>
      `const { ${bindings(clause, ': ')} } = __deps[${JSON.stringify(from)}]`)
    .replace(/^export\s*\{([^}]*)\}\s*;?$/gm, (_m, clause: string) =>
      clause.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
        const [local, exported = local] = entry.split(/\s+as\s+/)
        return `__exports[${JSON.stringify(exported)}] = ${local}`
      }).join('\n'))
    .replace(/^export default /gm, '__exports["default"] = ')

  const exports: Record<string, unknown> = {}
  new Function('__deps', '__exports', body)(deps, exports)
  return exports
}

function bindings(clause: string, separator: string): string {
  return clause
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/\s+as\s+/, separator))
    .join(', ')
}

async function loadHelloPlugin(contractBridge?: ReturnType<typeof createContractModuleBridge>) {
  const scanned = await scanPlugins(WORKSPACE_ROOT, scanBridge)
  return loadScannedPlugins(scanned.plugins, {
    importModule: createDesktopImportModule(WORKSPACE_ROOT, {
      evaluate: evaluateBlobModule,
      ...(contractBridge ? { contractBridge } : {}),
    }),
    host: createCore().plugins,
    apiVersionRange: HOST_API_VERSION_RANGE,
    isToolEnabled: () => true,
  })
}

describe('桌面链路上的裸说明符插件', () => {
  beforeEach(() => {
    created = []
    readWorkspaceFileMock.mockReset()
    readWorkspaceFileMock.mockResolvedValue({
      ok: true,
      data: { path: `${PLUGINS_DIR}/hello/plugin.mjs`, content: PLUGIN_ENTRY, truncated: false, bytes: PLUGIN_ENTRY.length },
    })
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      const url = `blob:test/${blobs.size}`
      blobs.set(url, blob as Blob)
      created.push(url)
      return url
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  })

  it('走默认契约桥（= 应用自己的 @einfach-agent/core/plugin 实例）时 enabled，工具照常过闸门', async () => {
    const result = await loadHelloPlugin()

    expect(result.plugins[0]).toMatchObject({
      dirName: 'hello',
      id: 'acme.hello',
      status: 'enabled',
      grantedTools: ['hello_from_plugin'],
      withheldTools: [],
    })
    // 造出来的两个 blob：先契约桥、后插件入口。插件那份里已经没有裸说明符了。
    const [bridgeUrl, entryUrl] = created
    const entrySource = await blobText(blobs.get(entryUrl) as Blob)
    expect(entrySource).not.toContain('@einfach-agent/core/plugin')
    expect(entrySource).toContain(bridgeUrl)
  })

  it('插件拿到的是另一份 core 副本的 definePlugin 时照样 enabled（品牌是全局注册表 Symbol）', async () => {
    // 模拟「插件解析到了第二份 @einfach-agent/core」：definePlugin 是另一份实现，
    // 但品牌 Symbol.for 落在同一个全局注册表里，所以宿主的 isPublicPlugin 仍认得出。
    const foreign = {
      definePlugin: (definition: object) =>
        Object.freeze({ ...definition, [Symbol.for('web-agent.public-plugin')]: true }),
    }
    const bridge = createContractModuleBridge({ modules: { '@einfach-agent/core/plugin': foreign } })

    const result = await loadHelloPlugin(bridge)

    expect(result.plugins[0]?.status).toBe('enabled')
    expect(result.plugins[0]?.grantedTools).toEqual(['hello_from_plugin'])
  })

  it('入口用动态 import() 引契约模块：failed，且诊断说清该怎么改', async () => {
    readWorkspaceFileMock.mockResolvedValue({
      ok: true,
      data: {
        path: `${PLUGINS_DIR}/hello/plugin.mjs`,
        content: "const m = await import('@einfach-agent/core/plugin')\nexport default m.definePlugin({})",
        truncated: false,
        bytes: 80,
      },
    })

    const result = await loadHelloPlugin()

    expect(result.plugins[0]?.status).toBe('failed')
    expect(result.plugins[0]?.diagnostics.join('\n')).toContain('静态 import')
  })
})
