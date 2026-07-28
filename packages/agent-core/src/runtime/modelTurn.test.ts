// modelTurn.test.ts —— buildTurnTools 的环境过滤（TP3）单测。
// ---------------------------------------------------------------------------
// 契约（TP3）：runtime:'server' 工具依赖 Tauri 本机能力，web 下不进 manifest。
//   · request_tool_schema 不内嵌无界 enum，目录改由有界的搜索/游标页返回；
//   · visible 展开也按同一判据过滤：web 下即便某 server 工具混进 visible 也不发给 model。
//   · request_tool_schema 元工具本身恒在场（两种 isTauri 都在返回列表首位）。
// 此环境 isTauri() 天然为 false，但这里直接传布尔参数，不依赖真实环境。

import { describe, it, expect } from 'vitest'
import {
  buildCustomInstructionsItem,
  buildEnvironmentItem,
  buildSystemItem,
  buildToolManifestText,
  buildTurnTools,
  canonicalizeJsonSchema,
  DEFAULT_TOOL_MANIFEST_PAGE_SIZE,
  loadedToolNamesFromHistory,
  MAX_TOOL_MANIFEST_PAGE_SIZE,
  MAX_TURN_TOOLS,
  parseToolCallArgs,
  searchToolManifestPage,
  selectTurnLoadedTools,
  touchRecentToolName,
  toolSetSchemaFingerprint,
} from './modelTurn'
import { toolRegistry } from '../tools/registry'
import { createToolRegistry } from '../tools/toolRegistry'
import type { LoadedTool } from '../tools/types'
import type { ModelFunctionTool, ModelItem } from '@web-agent/ai'

// 读取 request_tool_schema 的输入契约。parameters 类型为 unknown，就地收窄。
function loaderParameters(tools: ModelFunctionTool[]) {
  return tools[0].function.parameters as {
    properties: {
      toolName: { enum?: string[]; type: string }
      query: { maxLength: number; type: string }
      cursor: { type: string }
      limit: { default: number; maximum: number; minimum: number; type: string }
    }
    required: string[]
  }
}

// 真实 registry 里的一个 server 工具名与一个 internal 工具名（改动前先看实际 name）。
const SERVER_TOOL = 'shell_macos'
const SERVER_TOOL_2 = 'read_file'
const INTERNAL_TOOL = 'skill_search'

function fakeLoadedTool(name: string): LoadedTool {
  return {
    name,
    description: `description ${name}`,
    runtime: 'internal',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    guide: '',
  }
}

function registryWithTools(names: readonly string[]) {
  const registry = createToolRegistry()
  for (const name of names) {
    registry.register({
      name,
      runtime: 'internal',
      skill: { description: `description ${name}`, content: `# ${name}` },
      inputSchema: { type: 'object' },
      execute: async () => ({ ok: true }),
    })
  }
  return registry
}

describe('system 前缀缓存边界', () => {
  it('固定 system 不依赖本轮输入，也不内联任何 skill 名单（清单由 registry 单独出）', () => {
    const fixed = buildSystemItem()

    // 阶段 3：skill 名单不再由本模块按输入生成；system 里只留「正文经 skill_read」的协议条款。
    expect(fixed.content).toContain('skill 正文不在此展示')
    expect(fixed.content).not.toContain('planning —')
    expect(fixed.content).not.toContain('可用 skills')
    expect(buildSystemItem()).toEqual(fixed)
  })

  it('自定义指令为空时不注入，非空时作为独立 system 消息并清理首尾空白', () => {
    expect(buildCustomInstructionsItem(' \n ')).toBeUndefined()
    expect(buildCustomInstructionsItem('  请始终使用中文回复。\n')).toEqual({
      role: 'system',
      content: '用户在设置中保存了以下长期自定义指令，请在本次任务中遵循：\n请始终使用中文回复。',
    })
  })

  it('固定 system 含收尾自查与如实报告条款，且不含动态痕迹', () => {
    const fixed = buildSystemItem()

    expect(fixed.content).toContain('收尾自查')
    expect(fixed.content).toContain('如实报告')
    expect(fixed.content).not.toContain('可用 skills')
    expect(buildSystemItem()).toEqual(fixed)
  })
})

describe('buildEnvironmentItem —— 运行环境锚点', () => {
  it('桌面端给出 workspace 根目录、平台与反臆造条款', () => {
    const item = buildEnvironmentItem({
      workspaceRoot: '/Volumes/work/ai/web-agent',
      isTauri: true,
      platform: 'macos',
    })

    expect(item.role).toBe('system')
    expect(item.content).toContain('当前工作区根目录：/Volumes/work/ai/web-agent')
    expect(item.content).toContain('macos')
    // 这条是本段存在的理由：不给它，模型会编出训练数据里的绝对路径。
    expect(item.content).toContain('不要凭记忆或猜测写出本段未给出的绝对路径')
  })

  it('未绑定 workspace 时明说「以工具返回路径为准」，不伪造一个根目录', () => {
    const item = buildEnvironmentItem({ isTauri: true, platform: 'linux' })

    expect(item.content).toContain('未绑定工作区根目录')
    expect(item.content).toContain('先用一次目录列举取得实际根目录')
    expect(item.content).not.toContain('当前工作区根目录：')
    // 没有根目录时不能出现指代落空的「以该根目录为基准」。
    expect(item.content).not.toContain('以该根目录为基准')
  })

  it('web 宿主不谈 workspace 路径，只声明本机工具不可用', () => {
    const item = buildEnvironmentItem({
      workspaceRoot: '/Volumes/work/ai/web-agent',
      isTauri: false,
      platform: 'macos',
    })

    expect(item.content).toContain('本机文件、shell 与 Git 工具在本环境不可用')
    expect(item.content).not.toContain('/Volumes/work/ai/web-agent')
  })

  it('同一输入逐字稳定——它待在稳定前缀里，字节抖动即每轮 cache miss', () => {
    const input = { workspaceRoot: '/repo', isTauri: true, platform: 'macos' } as const

    expect(buildEnvironmentItem(input)).toEqual(buildEnvironmentItem(input))
    // 不含时间、轮次、计划状态等动态痕迹。
    expect(buildEnvironmentItem(input).content).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })
})

describe('buildTurnTools —— TP3 server 工具按环境过滤', () => {
  it('首轮工具摘要列出全部可发现工具，但未加载工具仍不进入 function tools', () => {
    const manifest = buildToolManifestText(true)
    const shellSummary = toolRegistry.list().find((tool) => tool.name === SERVER_TOOL)

    expect(shellSummary).toBeDefined()
    expect(manifest).toContain(`· ${SERVER_TOOL} [server] — ${shellSummary!.description}`)
    expect(manifest).toContain(`· ${INTERNAL_TOOL} [internal]`)
    expect(manifest).not.toContain('inputSchema')
    expect(manifest).not.toContain('"properties"')
    expect(buildTurnTools([], true).map((tool) => tool.function.name)).toEqual([
      'request_tool_schema',
    ])
  })

  it('web 工具摘要与 function tools 使用同一环境过滤，不暴露 server 工具', () => {
    const manifest = buildToolManifestText(false)

    expect(manifest).not.toContain(`· ${SERVER_TOOL} [server]`)
    expect(manifest).not.toContain(`· ${SERVER_TOOL_2} [server]`)
    expect(manifest).toContain(`· ${INTERNAL_TOOL} [internal]`)
  })

  it('工具摘要使用传入 registry、名称稳定排序，并折叠描述换行', () => {
    const registry = createToolRegistry()
    registry.register({
      name: 'z_tool',
      runtime: 'internal',
      skill: { description: 'line one\n  line two', content: '# full guide must stay lazy' },
      inputSchema: { type: 'object', properties: { secretSchema: { type: 'string' } } },
      execute: async () => ({ ok: true }),
    })
    registry.register({
      name: 'a_tool',
      runtime: 'internal',
      skill: { description: 'alpha', content: '# alpha guide' },
      inputSchema: { type: 'object' },
      execute: async () => ({ ok: true }),
    })

    const manifest = buildToolManifestText(true, { registry })
    expect(manifest.indexOf('· a_tool')).toBeLessThan(manifest.indexOf('· z_tool'))
    expect(manifest).toContain('· z_tool [internal] — line one line two')
    expect(manifest).not.toContain('full guide must stay lazy')
    expect(manifest).not.toContain('secretSchema')
    expect(manifest).not.toContain('skill_search')
  })

  it('request_tool_schema 元工具恒在场（两种 isTauri 都在返回列表首位）', () => {
    for (const isTauri of [false, true]) {
      const tools = buildTurnTools([], isTauri)
      expect(tools[0].function.name).toBe('request_tool_schema')
    }
  })

  it('request_tool_schema 不内嵌 registry enum，改为有界搜索/游标输入', () => {
    const parameters = loaderParameters(buildTurnTools([], false))
    expect(parameters.properties.toolName.enum).toBeUndefined()
    expect(parameters.required).toEqual(['reason'])
    expect(parameters.properties.query.type).toBe('string')
    expect(parameters.properties.cursor.type).toBe('string')
    expect(parameters.properties.limit).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: MAX_TOOL_MANIFEST_PAGE_SIZE,
      default: DEFAULT_TOOL_MANIFEST_PAGE_SIZE,
    })
  })

  it('web(false)：manifest 页不含任何 server 工具名，含 internal 工具名', () => {
    const page = searchToolManifestPage({ limit: MAX_TOOL_MANIFEST_PAGE_SIZE }, false)
    expect(page.kind).toBe('tool_manifest_page')
    if (page.kind !== 'tool_manifest_page') throw new Error(page.error)
    const names = page.items.map((tool) => tool.name)
    expect(names).not.toContain(SERVER_TOOL)
    expect(names).not.toContain(SERVER_TOOL_2)
    expect(names).toContain(INTERNAL_TOOL)
    // 更强：registry 里所有 server 工具都不在目录页里。
    const serverNames = toolRegistry
      .list()
      .filter((t) => t.runtime === 'server')
      .map((t) => t.name)
    expect(serverNames.length).toBeGreaterThan(0)
    for (const name of serverNames) {
      expect(names).not.toContain(name)
    }
  })

  it('Tauri(true)：manifest 页含 server 工具名', () => {
    const page = searchToolManifestPage({ limit: MAX_TOOL_MANIFEST_PAGE_SIZE }, true)
    expect(page.kind).toBe('tool_manifest_page')
    if (page.kind !== 'tool_manifest_page') throw new Error(page.error)
    const names = page.items.map((tool) => tool.name)
    expect(names).toContain(SERVER_TOOL)
    expect(names).toContain(INTERNAL_TOOL)
    // 当前内置 registry 小于单页上限，所有工具（含 server）都在第一页。
    expect(page.total).toBeLessThanOrEqual(MAX_TOOL_MANIFEST_PAGE_SIZE)
    for (const tool of toolRegistry.list()) {
      expect(names).toContain(tool.name)
    }

    // 最近真实运行中模型使用过这些英文查询；都应能发现当前平台 shell。
    for (const query of ['exec', 'terminal', 'run command']) {
      const search = searchToolManifestPage({ query }, true)
      expect(search.kind).toBe('tool_manifest_page')
      if (search.kind !== 'tool_manifest_page') throw new Error(search.error)
      expect(search.items.map((tool) => tool.name)).toContain('shell_macos')
    }
  })

  it('visible 过滤：server 工具 web 下不进 function 列表、Tauri 下进', () => {
    const fakeServer: LoadedTool = {
      name: 'shell_macos',
      description: 'x',
      runtime: 'server',
      inputSchema: { type: 'object' },
      guide: '',
    }

    const web = buildTurnTools([fakeServer], false)
    expect(web.map((t) => t.function.name)).not.toContain('shell_macos')

    const tauri = buildTurnTools([fakeServer], true)
    expect(tauri.map((t) => t.function.name)).toContain('shell_macos')
  })

  it('allowedToolNames 同时收窄 manifest 搜索和 visible functions', () => {
    const visible: LoadedTool[] = [
      {
        name: 'delegate_agent',
        description: 'delegate',
        runtime: 'internal',
        inputSchema: { type: 'object' },
        guide: '',
      },
      {
        name: 'skill_search',
        description: 'search',
        runtime: 'internal',
        inputSchema: { type: 'object' },
        guide: '',
      },
    ]

    const tools = buildTurnTools(visible, true, { allowedToolNames: ['delegate_agent'] })
    const page = searchToolManifestPage({}, true, { allowedToolNames: ['delegate_agent'] })
    expect(page.kind).toBe('tool_manifest_page')
    if (page.kind !== 'tool_manifest_page') throw new Error(page.error)
    expect(page.items.map((tool) => tool.name)).toEqual(['delegate_agent'])
    expect(tools.map((tool) => tool.function.name)).toEqual(['request_tool_schema', 'delegate_agent'])
  })

  it('registry 选项：manifest 搜索【传入的 registry】而非模块级 defaultCore.tools（TS1 隔离实例正确性 · codex [P1]）', () => {
    // 造一个只含自定义工具的独立 registry —— 模拟 createCore({ registerTools }) 装了自定义工具集的隔离实例。
    const custom = createToolRegistry()
    custom.register({
      name: 'custom_only_tool',
      runtime: 'internal',
      skill: { description: 'x', content: '# x' },
      inputSchema: { type: 'object', properties: {} },
      execute: async () => ({ ok: true }),
    })

    // 传 registry:custom → manifest 只反映这份 registry。
    const page = searchToolManifestPage({}, true, { registry: custom })
    expect(page.kind).toBe('tool_manifest_page')
    if (page.kind !== 'tool_manifest_page') throw new Error(page.error)
    const names = page.items.map((tool) => tool.name)
    expect(names).toContain('custom_only_tool')
    // 关键：不含模块级 defaultCore.tools 的标准工具（漏穿 core 时这两个会误入，本用例即会红）。
    expect(names).not.toContain('skill_search')
    expect(names).not.toContain('shell_macos')
  })
})

describe('buildTurnTools —— DeepSeek 128 工具硬预算', () => {
  const names = Array.from({ length: 140 }, (_, index) => `tool_${String(index).padStart(3, '0')}`)
  const visible = names.map(fakeLoadedTool)

  it('loader 固定占 1 个，总数不超过 128，并优先保留后加载工具', () => {
    const tools = buildTurnTools(visible, true)
    const selectedNames = tools.map((tool) => tool.function.name)

    expect(tools).toHaveLength(MAX_TURN_TOOLS)
    expect(selectedNames[0]).toBe('request_tool_schema')
    expect(selectedNames).not.toContain('tool_012')
    expect(selectedNames).toContain('tool_013')
    expect(selectedNames).toContain('tool_139')
    expect(selectedNames.slice(1)).toEqual([...selectedNames.slice(1)].sort())
  })

  it('maxTools 只能下调不能突破硬上限，最小预算仍保留 loader', () => {
    expect(buildTurnTools(visible, true, { maxTools: 999 })).toHaveLength(MAX_TURN_TOOLS)
    expect(buildTurnTools(visible, true, { maxTools: 1 }).map((tool) => tool.function.name))
      .toEqual(['request_tool_schema'])
  })

  it('recentToolNames 让已淘汰旧工具回到工作集，输出顺序仍保持稳定', () => {
    const tools = buildTurnTools(visible, true, {
      maxTools: 3,
      recentToolNames: ['tool_000'],
    })

    expect(tools.map((tool) => tool.function.name)).toEqual([
      'request_tool_schema',
      'tool_000',
      'tool_139',
    ])
    expect(selectTurnLoadedTools(visible, true, {
      maxTools: 3,
      recentToolNames: ['tool_000'],
    }).map((tool) => tool.name)).toEqual(['tool_000', 'tool_139'])
  })

  it('touchRecentToolName 去重、前移并限制 LRU 长度', () => {
    expect(touchRecentToolName(['tool_b', 'tool_a', 'tool_c'], 'tool_a', 3))
      .toEqual(['tool_a', 'tool_b', 'tool_c'])
    expect(touchRecentToolName(['tool_b', 'tool_a', 'tool_c'], 'tool_d', 2))
      .toEqual(['tool_d', 'tool_b'])
  })
})

describe('request_tool_schema —— 有界 manifest 搜索与游标', () => {
  const names = Array.from({ length: 73 }, (_, index) => `tool_${String(index).padStart(3, '0')}`)

  it('保留的 loader 名称不会被第三方注册项放进 manifest', () => {
    const registry = registryWithTools(['request_tool_schema', 'real_tool'])
    const result = searchToolManifestPage({}, true, { registry })

    expect(result.kind).toBe('tool_manifest_page')
    if (result.kind !== 'tool_manifest_page') throw new Error(result.error)
    expect(result.items.map((tool) => tool.name)).toEqual(['real_tool'])
  })

  it('逐页可遍历全部工具，每页严格有界且无重复/永久隐藏', () => {
    const registry = registryWithTools(names)
    const collected: string[] = []
    let cursor: string | undefined

    do {
      const result = searchToolManifestPage({ cursor, limit: 7 }, true, { registry })
      expect(result.kind).toBe('tool_manifest_page')
      if (result.kind !== 'tool_manifest_page') throw new Error(result.error)
      expect(result.items.length).toBeLessThanOrEqual(7)
      expect(result.total).toBe(names.length)
      collected.push(...result.items.map((tool) => tool.name))
      cursor = result.nextCursor
    } while (cursor)

    expect(collected).toEqual(names)
    expect(new Set(collected).size).toBe(names.length)
  })

  it('query 对 name/description/triggers 做大小写无关 AND 搜索，limit 被硬钳到页上限', () => {
    const registry = createToolRegistry()
    registry.register({
      name: 'alpha_reader',
      runtime: 'internal',
      skill: {
        description: 'Read Alpha Documents',
        triggers: ['terminal', '命令行'],
        content: '# alpha',
      },
      inputSchema: { type: 'object' },
      execute: async () => ({ ok: true }),
    })
    registry.register({
      name: 'alpha_writer',
      runtime: 'internal',
      skill: { description: 'Write Alpha Documents', content: '# alpha writer' },
      inputSchema: { type: 'object' },
      execute: async () => ({ ok: true }),
    })

    const result = searchToolManifestPage(
      { query: 'ALPHA read', limit: Number.MAX_SAFE_INTEGER },
      true,
      { registry },
    )
    expect(result.kind).toBe('tool_manifest_page')
    if (result.kind !== 'tool_manifest_page') throw new Error(result.error)
    expect(result.limit).toBe(MAX_TOOL_MANIFEST_PAGE_SIZE)
    expect(result.items.map((tool) => tool.name)).toEqual(['alpha_reader'])

    const triggerResult = searchToolManifestPage({ query: 'TERMINAL' }, true, { registry })
    expect(triggerResult.kind).toBe('tool_manifest_page')
    if (triggerResult.kind !== 'tool_manifest_page') throw new Error(triggerResult.error)
    expect(triggerResult.items.map((tool) => tool.name)).toEqual(['alpha_reader'])
  })

  it('目录变化或游标损坏会显式报错并给出重启参数，不会静默跳项', () => {
    const registry = registryWithTools(['a', 'b', 'c'])
    const first = searchToolManifestPage({ limit: 1 }, true, { registry })
    expect(first.kind).toBe('tool_manifest_page')
    if (first.kind !== 'tool_manifest_page') throw new Error(first.error)
    expect(first.nextCursor).toBeDefined()

    registry.register({
      name: 'd',
      runtime: 'internal',
      skill: { description: 'd', content: '# d' },
      inputSchema: { type: 'object' },
      execute: async () => ({ ok: true }),
    })
    expect(searchToolManifestPage({ cursor: first.nextCursor, limit: 1 }, true, { registry }))
      .toMatchObject({
        kind: 'tool_manifest_error',
        code: 'stale_cursor',
        restart: { query: '', limit: 1 },
      })
    expect(searchToolManifestPage({ cursor: 'not-a-cursor' }, true, { registry }))
      .toMatchObject({
        kind: 'tool_manifest_error',
        code: 'invalid_cursor',
      })
  })
})

describe('buildTurnTools —— 可缓存请求前缀保持确定性', () => {
  it('manifest 页与已加载 tools 均按稳定名称排序，且元工具始终第一', () => {
    const registry = createToolRegistry()
    for (const name of ['z_tool', 'a_tool', 'm_tool']) {
      registry.register({
        name,
        runtime: 'internal',
        skill: { description: name, content: `# ${name}` },
        inputSchema: { type: 'object' },
        execute: async () => ({ ok: true }),
      })
    }

    const visible: LoadedTool[] = ['z_tool', 'a_tool', 'm_tool'].map((name) => ({
      name,
      description: name,
      runtime: 'internal',
      inputSchema: { type: 'object' },
      guide: '',
    }))
    const tools = buildTurnTools(visible, true, { registry })
    const page = searchToolManifestPage({}, true, { registry })
    expect(page.kind).toBe('tool_manifest_page')
    if (page.kind !== 'tool_manifest_page') throw new Error(page.error)

    expect(page.items.map((tool) => tool.name)).toEqual(['a_tool', 'm_tool', 'z_tool'])
    expect(tools.map((tool) => tool.function.name)).toEqual([
      'request_tool_schema',
      'a_tool',
      'm_tool',
      'z_tool',
    ])
  })

  it('递归规范化 schema 对象键，不改变数组顺序，也不修改注册表原 schema', () => {
    const inputSchema = {
      zeta: {
        required: ['z', 'a'],
        properties: {
          z: { type: 'number' },
          a: { type: 'string' },
        },
      },
      alpha: {
        enum: ['z', 'a'],
        type: 'string',
      },
    }
    const originalTopLevelKeys = Object.keys(inputSchema)
    const originalNestedKeys = Object.keys(inputSchema.zeta.properties)
    const [metaTool, loadedTool] = buildTurnTools([{
      name: 'ordered_schema',
      description: 'schema ordering',
      runtime: 'internal',
      inputSchema,
      guide: '',
    }], true)

    const canonical = loadedTool.function.parameters as {
      alpha: { enum: string[]; type: string }
      zeta: {
        properties: Record<string, unknown>
        required: string[]
      }
    }
    expect(Object.keys(canonical)).toEqual(['alpha', 'zeta'])
    expect(Object.keys(canonical.zeta)).toEqual(['properties', 'required'])
    expect(Object.keys(canonical.zeta.properties)).toEqual(['a', 'z'])
    expect(canonical.zeta.required).toEqual(['z', 'a'])
    expect(canonical.alpha.enum).toEqual(['z', 'a'])
    expect(Object.keys(inputSchema)).toEqual(originalTopLevelKeys)
    expect(Object.keys(inputSchema.zeta.properties)).toEqual(originalNestedKeys)

    const metaParameters = metaTool.function.parameters as Record<string, unknown>
    expect(Object.keys(metaParameters)).toEqual([
      'additionalProperties',
      'properties',
      'required',
      'type',
    ])
  })

  it('规范化 helper 返回新对象并递归稳定键序', () => {
    const schema = {
      z: { y: 1, x: 2 },
      a: [{ d: 4, c: 3 }],
    }
    expect(canonicalizeJsonSchema(schema)).toEqual({
      a: [{ c: 3, d: 4 }],
      z: { x: 2, y: 1 },
    })
    expect(Object.keys(schema)).toEqual(['z', 'a'])
  })

  it('fingerprint 不受 tool/schema 插入顺序影响，schema 语义变化时改变', () => {
    const first: ModelFunctionTool[] = [
      {
        type: 'function',
        function: {
          name: 'z_tool',
          description: 'z',
          parameters: {
            type: 'object',
            properties: {
              z: { type: 'number' },
              a: { type: 'string' },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'request_tool_schema',
          description: 'loader',
          parameters: {
            type: 'object',
            properties: { toolName: { type: 'string' } },
          },
        },
      },
    ]
    const reordered: ModelFunctionTool[] = [
      {
        type: 'function',
        function: {
          name: 'request_tool_schema',
          description: 'loader',
          parameters: {
            properties: { toolName: { type: 'string' } },
            type: 'object',
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'z_tool',
          description: 'z',
          parameters: {
            properties: {
              a: { type: 'string' },
              z: { type: 'number' },
            },
            type: 'object',
          },
        },
      },
    ]
    const changed: ModelFunctionTool[] = [
      reordered[0],
      {
        ...reordered[1],
        function: {
          ...reordered[1].function,
          parameters: {
            properties: {
              a: { type: 'boolean' },
              z: { type: 'number' },
            },
            type: 'object',
          },
        },
      },
    ]

    const fingerprint = toolSetSchemaFingerprint(first)
    expect(fingerprint).toMatch(/^tools-v1-fnv1a32-[0-9a-f]{8}$/)
    expect(toolSetSchemaFingerprint(reordered)).toBe(fingerprint)
    expect(toolSetSchemaFingerprint(changed)).not.toBe(fingerprint)
  })
})

describe('loadedToolNamesFromHistory —— 从历史恢复顶层 schema', () => {
  it('按实时 loader 语义 trim 工具名后恢复', () => {
    const messages: ModelItem[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'trimmed-schema',
          type: 'function',
          function: {
            name: 'request_tool_schema',
            arguments: '{"toolName":"  skill_search  ","reason":"搜索"}',
          },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'trimmed-schema',
        content: '{"loaded":true,"toolName":"skill_search"}',
      },
    ]

    expect(loadedToolNamesFromHistory(messages)).toEqual(['skill_search'])
  })

  it('识别新旧两种成功结果并返回去重后的工具名，不改写历史消息', () => {
    const messages: ModelItem[] = [
      { role: 'user', content: '继续' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'new-schema',
          type: 'function',
          function: {
            name: 'request_tool_schema',
            arguments: '{"toolName":"skill_search","reason":"搜索"}',
          },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'new-schema',
        content: '{"loaded":true,"toolName":"skill_search","guide":"# search"}',
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'legacy-schema',
          type: 'function',
          function: {
            name: 'request_tool_schema',
            arguments: '{"toolName":"skill_search","reason":"旧记录"}',
          },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'legacy-schema',
        content: '{"name":"skill_search","runtime":"internal","inputSchema":{"type":"object"}}',
      },
    ]
    const originalMessages = JSON.stringify(messages)

    expect(loadedToolNamesFromHistory(messages)).toEqual(['skill_search'])
    expect(messages).toHaveLength(5)
    expect(JSON.stringify(messages)).toBe(originalMessages)
  })

  it('未回填或失败的 loader 调用不会恢复成已加载工具', () => {
    const pending: ModelItem[] = [{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'pending',
        type: 'function',
        function: {
          name: 'request_tool_schema',
          arguments: '{"toolName":"skill_search","reason":"搜索"}',
        },
      }],
    }]
    expect(loadedToolNamesFromHistory(pending)).toEqual([])

    const failed: ModelItem[] = [
      ...pending,
      { role: 'tool', tool_call_id: 'pending', content: '{"error":"unknown"}' },
    ]
    expect(loadedToolNamesFromHistory(failed)).toEqual([])
  })

  // 加载有两个等价入口：显式 request_tool_schema，以及模型直接调用未加载工具时闸门就地
  // 转成的那一次（modelRun）。后者同样让工具此后长期可用，恢复期漏认会让重启后白重载一次。
  it('直接调用被闸门转成的加载同样算已加载', () => {
    const messages: ModelItem[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'guessed',
          type: 'function',
          function: { name: 'skill_search', arguments: '{"skillName":"planning"}' },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'guessed',
        content: JSON.stringify({
          loaded: true,
          toolName: 'skill_search',
          guide: '# search',
          code: 'tool_schema_autoloaded',
          executed: false,
          hint: '本次调用未执行',
        }),
      },
    ]

    expect(loadedToolNamesFromHistory(messages)).toEqual(['skill_search'])
  })

  it('普通工具结果不会被误当成一次 schema 加载', () => {
    // 判别码 + 工具名自洽是硬判据：业务工具碰巧回了 {loaded:true,toolName} 也不算。
    const messages: ModelItem[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'real-call',
          type: 'function',
          function: { name: 'skill_search', arguments: '{"query":"planning"}' },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'real-call',
        content: '{"loaded":true,"toolName":"skill_search","results":[]}',
      },
    ]

    expect(loadedToolNamesFromHistory(messages)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// parseToolCallArgs —— 从 modelRun 提取到此，供主循环与 subagents 的第二条工具循环共用。
// ---------------------------------------------------------------------------
// 关键判据：区分「没传参」（合法，无参工具）与「传了坏 JSON」（不合法，绝不执行工具）。
// 被它取代的旧 safeParseArgs 把两者一律压成 {}，于是被 finish_reason='length' 截断的半截
// arguments 会被当成「模型就是不传参」而拿默认参数照常执行 —— 那是最难查的一类故障。
describe('parseToolCallArgs —— 判别联合式参数解析', () => {
  it('合法 JSON 对象：ok=true 且原样返回参数', () => {
    const parsed = parseToolCallArgs('{"query":"chart","limit":3}')
    expect(parsed).toEqual({ ok: true, args: { query: 'chart', limit: 3 } })
  })

  it('空串 / 纯空白 / undefined：都是无参工具的合法形态 → ok=true + {}', () => {
    for (const raw of ['', '   ', '\n\t', undefined]) {
      expect(parseToolCallArgs(raw)).toEqual({ ok: true, args: {} })
    }
  })

  it('被截断的半截 JSON：ok=false，带中文原因与 trim 后的原文（不能降级成 {}）', () => {
    const parsed = parseToolCallArgs('{"query": "cha')
    expect(parsed.ok).toBe(false)
    expect(parsed.args).toEqual({})
    if (parsed.ok) throw new Error('应当解析失败')
    expect(parsed.error).toContain('不是合法 JSON')
    expect(parsed.error).toContain('可能被截断')
    // raw 原样带回，供调用方回填 argumentsPreview 让模型认出自己发了什么。
    expect(parsed.raw).toBe('{"query": "cha')
  })

  it('合法 JSON 但不是对象（数组 / 标量 / null）：ok=false 且点名实际类型', () => {
    const cases: Array<[string, string]> = [
      ['[1,2,3]', 'array'],
      ['42', 'number'],
      ['"hi"', 'string'],
      ['true', 'boolean'],
      ['null', 'null'],
    ]
    for (const [raw, kind] of cases) {
      const parsed = parseToolCallArgs(raw)
      expect(parsed.ok).toBe(false)
      if (parsed.ok) throw new Error(`${raw} 应当解析失败`)
      expect(parsed.error).toContain('必须是 JSON 对象')
      expect(parsed.error).toContain(kind)
      expect(parsed.raw).toBe(raw)
      expect(parsed.args).toEqual({})
    }
  })

  it('前后空白不影响解析（trim 后再判）', () => {
    expect(parseToolCallArgs('  {"a":1}  ')).toEqual({ ok: true, args: { a: 1 } })
  })

  it('永不抛：任何输入都返回判别联合', () => {
    // 注意：纯空白不在此列 —— 它是「无参调用」的合法形态，见上面的空串用例。
    for (const raw of ['{', '}{', '{"a":', 'undefined', '{,}', '[']) {
      expect(() => parseToolCallArgs(raw)).not.toThrow()
      expect(parseToolCallArgs(raw).ok).toBe(false)
    }
  })
})
