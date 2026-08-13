import { describe, expect, it, vi } from 'vitest'
import { definePlugin } from '../runtime/core/pluginContracts'
import type { Tool } from '../tools/types'
import { gatePluginTools, isGatedModelVisibleTool, withheldToolsDiagnostic } from './pluginToolGate'

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

const denyAll = () => false

function installGated(
  source: Parameters<typeof gatePluginTools>[0],
  options: Partial<Parameters<typeof gatePluginTools>[1]> = {},
): { outcome: ReturnType<typeof gatePluginTools>['outcome']; registered: string[] } {
  const gated = gatePluginTools(source, {
    pluginId: 'acme.hello',
    declaresToolsCapability: true,
    isToolEnabled: denyAll,
    ...options,
  })
  const registered: string[] = []
  gated.plugin.install?.({ registerTool: (tool) => { registered.push(tool.name) } })
  return { outcome: gated.outcome, registered }
}

describe('isGatedModelVisibleTool', () => {
  it('无 callTiming 的工具是模型可见的', () => {
    expect(isGatedModelVisibleTool(probeTool('a'))).toBe(true)
  })

  it('到点工具不是模型可见的', () => {
    expect(isGatedModelVisibleTool(probeTool('a', { callTiming: 'turnEnd' }))).toBe(false)
  })

  it('external 工具的 callTiming 会被注册期剥除，故仍按模型可见判定', () => {
    expect(isGatedModelVisibleTool(probeTool('a', { callTiming: 'turnEnd', origin: 'external' })))
      .toBe(true)
  })
})

describe('gatePluginTools', () => {
  it('默认拦下模型可见工具，勾选的放行', () => {
    const source = definePlugin({
      install(api) {
        api.registerTool(probeTool('kept'))
        api.registerTool(probeTool('dropped'))
      },
    })

    const { outcome, registered } = installGated(source, {
      isToolEnabled: (_id, name) => name === 'kept',
    })

    expect(registered).toEqual(['kept'])
    expect(outcome.granted).toEqual(['kept'])
    expect(outcome.withheld).toEqual(['dropped'])
  })

  it('未申报 tools 能力却注册工具时记一条诊断，且只记一次', () => {
    const source = definePlugin({
      install(api) {
        api.registerTool(probeTool('one'))
        api.registerTool(probeTool('two'))
      },
    })

    const { outcome } = installGated(source, { declaresToolsCapability: false })

    expect(outcome.diagnostics).toHaveLength(1)
    expect(outcome.diagnostics[0]).toContain('未申报 `tools` 能力')
    expect(outcome.withheld).toEqual(['one', 'two'])
  })

  it('install 返回后迟到的注册一律拒绝——注册只允许发生在 install 回调里', () => {
    let escaped: ((tool: Tool) => void) | undefined
    const source = definePlugin({
      install(api) {
        escaped = api.registerTool
      },
    })

    const { outcome, registered } = installGated(source, { isToolEnabled: () => true })
    escaped?.(probeTool('late'))

    expect(registered).toEqual([])
    expect(outcome.granted).toEqual([])
    expect(outcome.diagnostics.join('\n')).toContain('在 install 回调返回后才注册，已拒绝')
  })

  it('install 抛错时闸门照样封口，异常原样上抛给调用方处理', () => {
    let escaped: ((tool: Tool) => void) | undefined
    const source = definePlugin({
      install(api) {
        escaped = api.registerTool
        throw new Error('boom')
      },
    })
    const gated = gatePluginTools(source, {
      pluginId: 'acme.hello',
      declaresToolsCapability: true,
      isToolEnabled: () => true,
    })

    expect(() => gated.plugin.install?.({ registerTool: () => {} })).toThrow('boom')
    escaped?.(probeTool('late'))
    expect(gated.outcome.granted).toEqual([])
    expect(gated.outcome.diagnostics.join('\n')).toContain('已拒绝')
  })

  it('透传 install disposer 与 activate，闸门不改 hook 面', () => {
    const disposer = vi.fn()
    const activate = vi.fn()
    const source = definePlugin({ install: () => disposer, activate })
    const gated = gatePluginTools(source, {
      pluginId: 'acme.hello',
      declaresToolsCapability: false,
      isToolEnabled: denyAll,
    })

    const returned = gated.plugin.install?.({ registerTool: () => {} })
    expect(returned).toBe(disposer)

    const api = {} as Parameters<NonNullable<typeof activate>>[0]
    gated.plugin.activate?.(api)
    expect(activate).toHaveBeenCalledWith(api)
  })

  it('没有 activate 的插件不会被补出一个 activate', () => {
    const gated = gatePluginTools(definePlugin({ install() {} }), {
      pluginId: 'acme.hello',
      declaresToolsCapability: false,
      isToolEnabled: denyAll,
    })
    expect(gated.plugin.activate).toBeUndefined()
  })
})

describe('withheldToolsDiagnostic', () => {
  it('无拦截时不产出诊断', () => {
    expect(withheldToolsDiagnostic('acme.hello', [])).toBeUndefined()
  })

  it('有拦截时点名工具并指向插件面板', () => {
    const line = withheldToolsDiagnostic('acme.hello', ['a', 'b'])
    expect(line).toContain('acme.hello')
    expect(line).toContain('a、b')
    expect(line).toContain('勾选')
  })
})
