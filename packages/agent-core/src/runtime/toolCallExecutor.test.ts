// E2 的收口：闸门放行之后、registry 真正执行之前的那段 await 窗口。
// ---------------------------------------------------------------------------
// 危险工具确认恢复、插件 before-tool hook、并行批次都会在「闸门判过」和「registry.run 落地」
// 之间插入 await。MCP 恰好在这段时间掉线时，闸门是拦不住的——只有执行侧还能补一刀。
// 这里钉死两件事：
//   · registry 的 expectedRegistrationVersion fail-closed 照旧先跑（绝不提前拦、绝不绕过），
//     失败之后才按 epoch.status() 把回执翻译成模型能据以改道的结构化结果；
//   · 工具还活着时的普通失败原样返回，绝不被这条翻译吞掉。

import { describe, expect, it, vi } from 'vitest'
import { sessionsAtom } from '../state/rootAtoms'
import { setRun } from '../state/sessionWriters'
import { createCoreInstance } from './core/coreInstance'
import type { Tool, ToolResult } from '../tools/types'
import type { ToolLoopBase } from './toolLoopContracts'
import { createToolEpoch } from './toolEpoch'
import { executeToolCall } from './toolCallExecutor'

const TOOL_NAME = 'mcp_backed_tool'

function testTool(execute: Tool['execute']): Tool {
  return {
    name: TOOL_NAME,
    runtime: 'internal',
    skill: { description: '测试工具', content: '仅测试用。' },
    inputSchema: { type: 'object', additionalProperties: true },
    execute,
  }
}

function createHarness(execute: Tool['execute']) {
  const tool = testTool(execute)
  const core = createCoreInstance({ registerTools: (registry) => registry.register(tool) })
  core.rootStore.setter(sessionsAtom, {
    session: {
      id: 'session',
      title: 'executor',
      createdAt: 0,
      updatedAt: 0,
      settings: { vendor: 'deepseek', model: 'test-model' },
    },
  })
  setRun('session', { runId: 'run', status: 'running', turnId: 'turn', startedAt: 0 }, core)

  const base = {
    id: 'session',
    runId: 'run',
    turnId: 'turn',
    core,
    // epoch 在工具还活着时冻结：这正是「闸门放行时它还在」的现场。
    toolEpoch: createToolEpoch(core.tools, { sessionId: 'session', runId: 'run' }),
    opts: { apiKey: 'test-key', signal: new AbortController().signal },
    maxTurnTools: 8,
    hostHasLocalCapabilities: true,
    trace: { span: {} as never, event: vi.fn(), finish: vi.fn() },
    control: { isCurrent: () => true, isRunning: () => true },
    hooks: {},
    state: { visible: [], recentToolNames: [], consecutivePlanTextTurns: 0, stageTurnsOnGuard: 0 },
  } as unknown as ToolLoopBase

  return { base, core, tool, registrationVersion: core.tools.registrationVersion(TOOL_NAME)! }
}

describe('executeToolCall —— 执行期掉线', () => {
  it('闸门之后掉线：把 registry 的 unknown tool 翻成结构化回执，并留住原始错误', async () => {
    const execute = vi.fn(() => ({ ok: true as const }))
    const { base, core, tool, registrationVersion } = createHarness(execute)

    // 闸门已经放行（epoch 里它还是 live），await 窗口里 MCP 掉线。
    expect(core.tools.unregister(TOOL_NAME, tool)).toBe(true)
    expect(base.toolEpoch.status(TOOL_NAME)).toBe('retired')

    const result = await executeToolCall(base, {
      callId: 'call-1', name: TOOL_NAME, args: {}, registrationVersion,
    }) as Extract<ToolResult, { ok: false }>

    expect(execute).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(result.code).toBe('tool_provider_disconnected')
    expect(result.retryable).toBe(false)
    expect(result.error).toContain('MCP 服务在本轮已断开')
    expect(result.error).not.toContain('unknown tool')
    // registry 的 fail-closed 仍然照常发生，只是不再直接怼给模型。
    expect(result.details).toEqual({ underlyingError: `unknown tool: ${TOOL_NAME}` })
  })

  it('同名重注册导致的版本 fail-closed 不被改写（工具还活着，走既有自愈路径）', async () => {
    const execute = vi.fn(() => ({ ok: true as const }))
    const { base, core, registrationVersion } = createHarness(execute)

    core.tools.register(testTool(execute))
    expect(base.toolEpoch.status(TOOL_NAME)).toBe('live')

    const result = await executeToolCall(base, {
      callId: 'call-2', name: TOOL_NAME, args: {}, registrationVersion,
    }) as Extract<ToolResult, { ok: false }>

    expect(execute).not.toHaveBeenCalled()
    expect(result.error).toContain('tool registration version mismatch')
    expect(result.code).toBeUndefined()
  })

  it('工具还活着时的普通失败原样返回', async () => {
    const execute = vi.fn(() => ({ ok: false as const, error: '路径不存在' }))
    const { base, registrationVersion } = createHarness(execute)

    const result = await executeToolCall(base, {
      callId: 'call-3', name: TOOL_NAME, args: {}, registrationVersion,
    }) as Extract<ToolResult, { ok: false }>

    expect(result).toEqual({ ok: false, error: '路径不存在' })
  })
})
