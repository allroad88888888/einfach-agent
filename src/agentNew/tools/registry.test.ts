import { describe, it, expect } from 'vitest'
import { createToolRegistry, toolRegistry, type ToolRegistry } from './registry'
import type { Tool, ToolContext } from './types'
import './register'

// 最小 fake ctx：registry.run 只把它原样透传给 tool.execute，本文件不校验副作用面。
const ctx: ToolContext = {
  sessionId: 's',
  signal: new AbortController().signal,
  progress() {},
  callTool: async () => ({ ok: true }),
  runShell: async (input) => ({
    platform: input.platform,
    shell: 'test',
    command: input.command,
    cwd: input.cwd ?? '',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 0,
    timedOut: false,
    truncated: false,
  }),
  renderCard: () => ({ cardId: 'x' }),
  saveArtifact: () => ({ artifactId: 'y' }),
}

// inline fake Tool 构造器：默认一个 internal 工具，execute 回 { ok:true, data }。
// 各用例用 overrides 定制 name/skill/inputSchema/execute。
function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'demo',
    runtime: 'internal',
    skill: { description: 'demo 一句话摘要', triggers: ['demo'], content: '# demo 指南正文' },
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    execute: async () => ({ ok: true, data: { echoed: true } }),
    ...overrides,
  }
}

describe('tools/registry —— 抽象工厂 ToolRegistry（§3/§4）', () => {
  it('模块级单例 toolRegistry 就是一个可用的 ToolRegistry', () => {
    const reg: ToolRegistry = toolRegistry
    expect(typeof reg.register).toBe('function')
    expect(typeof reg.has).toBe('function')
    expect(typeof reg.list).toBe('function')
    expect(typeof reg.loadSchema).toBe('function')
    expect(typeof reg.run).toBe('function')
  })

  it('register 后 has/list 反映；list 项只有 name/description(=skill.description)/runtime', () => {
    const reg = createToolRegistry()
    expect(reg.has('demo')).toBe(false)

    reg.register(makeTool())

    expect(reg.has('demo')).toBe(true)
    const list = reg.list()
    expect(list).toHaveLength(1)
    const [item] = list
    // description 取自 skill.description（terse）。
    expect(item).toEqual({ name: 'demo', description: 'demo 一句话摘要', runtime: 'internal' })
    // manifest-only（TK3）：绝不含 inputSchema / guide / content / skill。
    expect(item).not.toHaveProperty('inputSchema')
    expect(item).not.toHaveProperty('guide')
    expect(item).not.toHaveProperty('content')
    expect(item).not.toHaveProperty('skill')
  })

  it('同名 register 覆盖（幂等，后注册胜）', () => {
    const reg = createToolRegistry()
    reg.register(makeTool({ skill: { description: '旧', content: '旧正文' } }))
    reg.register(makeTool({ skill: { description: '新', content: '新正文' } }))

    expect(reg.list()).toHaveLength(1)
    expect(reg.list()[0].description).toBe('新')
    expect(reg.loadSchema('demo')?.guide).toBe('新正文')
  })

  it('loadSchema：在 summary 之上补 inputSchema + guide(=skill.content)', () => {
    const reg = createToolRegistry()
    reg.register(makeTool())

    const loaded = reg.loadSchema('demo')
    expect(loaded).toEqual({
      name: 'demo',
      description: 'demo 一句话摘要',
      runtime: 'internal',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      guide: '# demo 指南正文',
    })
  })

  it('loadSchema 未知名 → undefined', () => {
    const reg = createToolRegistry()
    expect(reg.loadSchema('nope')).toBeUndefined()
  })

  it('内置 shell tools 已注册，manifest-only；loadSchema 才暴露 schema + guide', () => {
    const shellNames = ['shell_macos', 'shell_linux', 'shell_powershell']
    const list = toolRegistry.list().filter((tool) => shellNames.includes(tool.name))

    expect(list.map((tool) => tool.name).sort()).toEqual([...shellNames].sort())
    for (const item of list) {
      expect(Object.keys(item).sort()).toEqual(['description', 'name', 'runtime'])
      expect(item.runtime).toBe('server') // 依赖 Tauri 本机 shell（TP3）。
    }

    const loaded = toolRegistry.loadSchema('shell_macos')
    expect(loaded?.inputSchema).toMatchObject({ required: ['command'] })
    expect(loaded?.guide.length).toBeGreaterThan(0)
  })

  it('内置 workspace file tools 已注册，manifest-only；loadSchema 才暴露 schema + guide', () => {
    const fileToolNames = [
      'read_file',
      'list_files',
      'search_files',
      'apply_patch',
      'write_file',
      'git_diff_review',
    ]
    const list = toolRegistry.list().filter((tool) => fileToolNames.includes(tool.name))

    expect(list.map((tool) => tool.name).sort()).toEqual([...fileToolNames].sort())
    for (const item of list) {
      expect(Object.keys(item).sort()).toEqual(['description', 'name', 'runtime'])
      expect(item.runtime).toBe('server') // 依赖 Tauri 文件系统/git（TP3）。
    }

    const loaded = toolRegistry.loadSchema('apply_patch')
    expect(loaded?.inputSchema).toMatchObject({ required: ['operations'] })
    expect(loaded?.guide.length).toBeGreaterThan(0)
  })

  it('run 未知名 → { ok:false, error 含 "unknown tool" }（不抛）', async () => {
    const reg = createToolRegistry()
    const res = await reg.run('nope', {}, ctx)
    expect(res).toEqual({ ok: false, error: 'unknown tool: nope' })
  })

  it('run 正常工具 → 透传其 ToolResult', async () => {
    const reg = createToolRegistry()
    reg.register(makeTool({ execute: async () => ({ ok: true, data: { n: 42 } }) }))
    const res = await reg.run('demo', { q: 'x' }, ctx)
    expect(res).toEqual({ ok: true, data: { n: 42 } })
  })

  it('run 工具 execute 抛普通 Error → { ok:false, error:消息 }（不抛，TK6）', async () => {
    const reg = createToolRegistry()
    reg.register(
      makeTool({
        execute: () => {
          throw new Error('boom')
        },
      }),
    )
    const res = await reg.run('demo', {}, ctx)
    expect(res).toEqual({ ok: false, error: 'boom' })
  })

  it('run 工具 execute 抛 AbortError → rethrow 透传（不封装）', async () => {
    const reg = createToolRegistry()
    const abortErr = new Error('aborted')
    abortErr.name = 'AbortError'
    reg.register(
      makeTool({
        execute: () => {
          throw abortErr
        },
      }),
    )
    await expect(reg.run('demo', {}, ctx)).rejects.toBe(abortErr)
  })
})
