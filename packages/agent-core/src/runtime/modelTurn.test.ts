// modelTurn.test.ts —— buildTurnTools 的环境过滤（TP3）单测。
// ---------------------------------------------------------------------------
// 契约（TP3）：runtime:'server' 工具依赖 Tauri 本机能力，web 下不进 manifest。
//   · request_tool_schema 的 toolName enum：web(false) 不含 server 工具名、含 internal 工具名；
//     Tauri(true) 含 server 工具名。
//   · visible 展开也按同一判据过滤：web 下即便某 server 工具混进 visible 也不发给 model。
//   · request_tool_schema 元工具本身恒在场（两种 isTauri 都在返回列表首位）。
// 此环境 isTauri() 天然为 false，但这里直接传布尔参数，不依赖真实环境。

import { describe, it, expect } from 'vitest'
import { buildTurnTools, parseToolCallArgs } from './modelTurn'
import { toolRegistry } from '../tools/registry'
import { createToolRegistry } from '../tools/toolRegistry'
import type { LoadedTool } from '../tools/types'
import type { ModelFunctionTool } from '@web-agent/ai'

// 从 request_tool_schema 元工具里取 toolName enum（真实 registry 名字）。parameters 类型为 unknown，就地收窄。
function schemaEnum(tools: ModelFunctionTool[]): string[] {
  const params = tools[0].function.parameters as {
    properties: { toolName: { enum?: string[] } }
  }
  return params.properties.toolName.enum ?? []
}

// 真实 registry 里的一个 server 工具名与一个 internal 工具名（改动前先看实际 name）。
const SERVER_TOOL = 'shell_macos'
const SERVER_TOOL_2 = 'read_file'
const INTERNAL_TOOL = 'skill_search'

describe('buildTurnTools —— TP3 server 工具按环境过滤', () => {
  it('request_tool_schema 元工具恒在场（两种 isTauri 都在返回列表首位）', () => {
    for (const isTauri of [false, true]) {
      const tools = buildTurnTools([], isTauri)
      expect(tools[0].function.name).toBe('request_tool_schema')
    }
  })

  it('web(false)：enum 不含任何 server 工具名，含 internal 工具名', () => {
    const names = schemaEnum(buildTurnTools([], false))
    expect(names).not.toContain(SERVER_TOOL)
    expect(names).not.toContain(SERVER_TOOL_2)
    expect(names).toContain(INTERNAL_TOOL)
    // 更强：registry 里所有 server 工具都不在 enum 里。
    const serverNames = toolRegistry
      .list()
      .filter((t) => t.runtime === 'server')
      .map((t) => t.name)
    expect(serverNames.length).toBeGreaterThan(0)
    for (const name of serverNames) {
      expect(names).not.toContain(name)
    }
  })

  it('Tauri(true)：enum 含 server 工具名', () => {
    const names = schemaEnum(buildTurnTools([], true))
    expect(names).toContain(SERVER_TOOL)
    expect(names).toContain(INTERNAL_TOOL)
    // 更强：registry 里所有工具（含 server）都在 enum 里。
    for (const tool of toolRegistry.list()) {
      expect(names).toContain(tool.name)
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

  it('allowedToolNames 同时收窄 request enum 和 visible functions', () => {
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
    expect(schemaEnum(tools)).toEqual(['delegate_agent'])
    expect(tools.map((tool) => tool.function.name)).toEqual(['request_tool_schema', 'delegate_agent'])
  })

  it('registry 选项：enum 枚举【传入的 registry】而非模块级 defaultCore.tools（TS1 隔离实例正确性 · codex [P1]）', () => {
    // 造一个只含自定义工具的独立 registry —— 模拟 createCore({ registerTools }) 装了自定义工具集的隔离实例。
    const custom = createToolRegistry()
    custom.register({
      name: 'custom_only_tool',
      runtime: 'internal',
      skill: { description: 'x', content: '# x' },
      inputSchema: { type: 'object', properties: {} },
      execute: async () => ({ ok: true }),
    })

    // 传 registry:custom → enum 只反映这份 registry。
    const names = schemaEnum(buildTurnTools([], true, { registry: custom }))
    expect(names).toContain('custom_only_tool')
    // 关键：不含模块级 defaultCore.tools 的标准工具（漏穿 core 时这两个会误入，本用例即会红）。
    expect(names).not.toContain('skill_search')
    expect(names).not.toContain('shell_macos')
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
