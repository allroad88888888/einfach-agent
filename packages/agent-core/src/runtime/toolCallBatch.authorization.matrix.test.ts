import { describe, expect, it, vi } from 'vitest'
import type { ModelFunctionTool, ModelToolCall } from '@web-agent/ai'
import { sessionsAtom } from '../state/rootAtoms'
import { runAtom } from '../state/sessionAtoms'
import { alwaysAllowedToolsAtom } from '../state/transientAtoms'
import { setRun } from '../state/sessionWriters'
import { createCoreInstance, type RuntimeConfig } from './core/coreInstance'
import { MCP_CONNECT_TOOL_NAME, type McpConnectTargetProbe } from './dangerousTools'
import type { Tool } from '../tools/types'
import type { ToolLoopBase } from './toolLoopContracts'
import { runToolCallBatch } from './toolCallBatch'
import { createToolEpoch } from './toolEpoch'
import type { ModelTurnResult } from './modelTurnRequester'

const shellTools = ['shell_macos', 'shell_linux', 'shell_powershell'] as const
const approvalModes = ['confirm', 'auto'] as const

function createTestTool(name: string, execute: Tool['execute']): Tool {
  return {
    name,
    runtime: 'server',
    skill: { description: 'Test tool', content: 'Test-only tool.' },
    inputSchema: { type: 'object', additionalProperties: true },
    execute,
  }
}

function createHarness(
  name: string,
  approvalMode: 'confirm' | 'auto',
  config?: Partial<RuntimeConfig>,
  alwaysAllowedTools?: readonly string[],
) {
  const execute = vi.fn(async () => ({ ok: true as const, data: { completed: true } }))
  const core = createCoreInstance({
    config,
    registerTools: registry => registry.register(createTestTool(name, execute)),
  })

  core.rootStore.setter(sessionsAtom, {
    session: {
      id: 'session',
      title: 'Authorization matrix',
      createdAt: 0,
      updatedAt: 0,
      settings: { vendor: 'deepseek', model: 'test-model' },
      toolApprovalMode: approvalMode,
    },
  })
  setRun('session', { runId: 'run', status: 'running', turnId: 'turn', startedAt: 0 }, core)
  // 绕开写入器直接种「一律允许」：模拟历史数据 / 越权写入，逼 batch 只能靠读侧判据自保。
  if (alwaysAllowedTools) {
    core.getSessionStore('session').store.setter(alwaysAllowedToolsAtom, [...alwaysAllowedTools])
  }

  const base = {
    id: 'session',
    runId: 'run',
    turnId: 'turn',
    core,
    toolEpoch: createToolEpoch(core.tools, { sessionId: 'session', runId: 'run' }),
    opts: { apiKey: 'test-key', signal: new AbortController().signal },
    maxTurnTools: 8,
    runtimeIsTauri: true,
    trace: { span: {} as never, event: vi.fn(), finish: vi.fn() },
    control: { isCurrent: () => true, isRunning: () => true },
    hooks: {},
    state: {
      visible: [],
      recentToolNames: [],
      consecutivePlanTextTurns: 0,
      stageTurnsOnGuard: 0,
    },
  } as unknown as ToolLoopBase

  return { base, execute, core }
}

function createModelTool(name: string): ModelFunctionTool {
  return {
    type: 'function',
    function: {
      name,
      description: `Test ${name}`,
      parameters: { type: 'object', additionalProperties: true },
    },
  }
}

function createToolCall(name: string, arguments_: Record<string, unknown>): ModelToolCall {
  return {
    id: `call-${name}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(arguments_) },
  }
}

async function runCall(
  name: string,
  approvalMode: 'confirm' | 'auto',
  arguments_: Record<string, unknown>,
  config?: Partial<RuntimeConfig>,
  alwaysAllowedTools?: readonly string[],
) {
  const { base, execute, core } = createHarness(name, approvalMode, config, alwaysAllowedTools)
  const result = await runToolCallBatch(base, {
    result: {
      toolCalls: [createToolCall(name, arguments_)],
      tools: [createModelTool(name)],
      exposedRegistrationVersions: new Map([[name, core.tools.registrationVersion(name)]]),
    } as unknown as ModelTurnResult,
    finishReason: 'tool_calls',
    persistWorkingTurn: vi.fn(),
    recordToolOutcome: vi.fn(),
  })

  return { result, execute, run: core.getSessionStore('session').store.getter(runAtom) }
}

describe('tool-call authorization matrix', () => {
  it.each(shellTools)('pauses %s in confirm mode', async name => {
    const { result, execute, run } = await runCall(name, 'confirm', { command: 'echo ok' })

    expect(result).toBe('paused')
    expect(execute).not.toHaveBeenCalled()
    expect(run).toMatchObject({
      status: 'waiting_confirmation',
      pendingToolConfirmation: { toolName: name },
    })
  })

  it.each(shellTools)('pauses critical recursive deletion through %s in auto mode', async name => {
    const { result, execute, run } = await runCall(name, 'auto', { command: 'rm -rf /' })

    expect(result).toBe('paused')
    expect(execute).not.toHaveBeenCalled()
    expect(run).toMatchObject({
      status: 'waiting_confirmation',
      pendingToolConfirmation: { toolName: name, risk: 'critical' },
    })
  })

  it('executes write_file directly in auto mode', async () => {
    const { result, execute, run } = await runCall('write_file', 'auto', {
      path: 'note.txt',
      content: 'hello',
    })

    expect(result).toBe('continue')
    expect(execute).toHaveBeenCalledOnce()
    expect(run?.status).toBe('running')
  })

  it('executes MCP tools directly in auto mode', async () => {
    const { result, execute, run } = await runCall('mcp__github__create_issue', 'auto', {
      title: 'Created without a confirmation card',
    })

    expect(result).toBe('continue')
    expect(execute).toHaveBeenCalledOnce()
    expect(run?.status).toBe('running')
  })

  it.each(approvalModes)('executes git_diff_review directly in %s mode', async approvalMode => {
    const { result, execute, run } = await runCall('git_diff_review', approvalMode, {})

    expect(result).toBe('continue')
    expect(execute).toHaveBeenCalledOnce()
    expect(run?.status).toBe('running')
  })
})

// 这一组守的是【接线】：核心策略在 dangerousTools.test.ts 里已单测过，这里跑真的
// runToolCallBatch，确认 core.config.mcpConnectTarget 确实被喂进了 classifyToolRisk。
// 谁把那个字段从 toolCallBatch 的 context 里拿掉，HTTP 那条就会从 continue 变成 paused。
describe('connect_mcp_server authorization by transport', () => {
  const STDIO_COMMAND = 'node /Users/me/tools/server.js --stdio'
  const mcpConnectTarget: McpConnectTargetProbe = serverId => {
    if (serverId === 'local-tools') return { spawnsLocalProcess: true, command: STDIO_COMMAND }
    if (serverId === 'remote-tools') return { spawnsLocalProcess: false }
    return undefined
  }

  it('pauses a stdio server connect and shows the command that will run', async () => {
    const { result, execute, run } = await runCall(
      MCP_CONNECT_TOOL_NAME,
      'confirm',
      { serverId: 'local-tools' },
      { mcpConnectTarget },
    )

    expect(result).toBe('paused')
    expect(execute).not.toHaveBeenCalled()
    expect(run).toMatchObject({
      status: 'waiting_confirmation',
      pendingToolConfirmation: { toolName: MCP_CONNECT_TOOL_NAME },
    })
    expect(run?.pendingToolConfirmation?.reason).toContain(STDIO_COMMAND)
  })

  it('executes an HTTP server connect without a confirmation card', async () => {
    const { result, execute, run } = await runCall(
      MCP_CONNECT_TOOL_NAME,
      'confirm',
      { serverId: 'remote-tools' },
      { mcpConnectTarget },
    )

    expect(result).toBe('continue')
    expect(execute).toHaveBeenCalledOnce()
    expect(run?.status).toBe('running')
  })

  it('pauses when the host never wired a transport probe', async () => {
    const { result, execute, run } = await runCall(
      MCP_CONNECT_TOOL_NAME,
      'confirm',
      { serverId: 'local-tools' },
    )

    expect(result).toBe('paused')
    expect(execute).not.toHaveBeenCalled()
    expect(run?.status).toBe('waiting_confirmation')
  })

  it('pauses when the probe does not know the server id', async () => {
    const { result, execute } = await runCall(
      MCP_CONNECT_TOOL_NAME,
      'confirm',
      { serverId: 'never-configured' },
      { mcpConnectTarget },
    )

    expect(result).toBe('paused')
    expect(execute).not.toHaveBeenCalled()
  })

  // F7：连接工具永远拿不到 session 级「一律允许」，所以【每一次】连接都要单独确认。
  // 记忆是按工具名的：如果它能被记住，用户对某一个服务的一次同意，就成了本会话内连接任意
  // 已配置服务（包括在本机起进程的 stdio 服务）的通行证。
  it('pauses every stdio connect even when the session already remembers the connect tool', async () => {
    const { result, execute, run } = await runCall(
      MCP_CONNECT_TOOL_NAME,
      'confirm',
      { serverId: 'local-tools' },
      { mcpConnectTarget },
      [MCP_CONNECT_TOOL_NAME],
    )

    expect(result).toBe('paused')
    expect(execute).not.toHaveBeenCalled()
    expect(run).toMatchObject({
      status: 'waiting_confirmation',
      pendingToolConfirmation: { toolName: MCP_CONNECT_TOOL_NAME },
    })
  })

  // 对照组：普通危险工具的 session 记忆仍然照常生效，别把闸门修成一刀切。
  it('still honors a remembered approval for an ordinary dangerous tool', async () => {
    const { result, execute } = await runCall(
      'write_file',
      'confirm',
      { path: 'note.txt', content: 'hello' },
      undefined,
      ['write_file'],
    )

    expect(result).toBe('continue')
    expect(execute).toHaveBeenCalledOnce()
  })

  // Auto 模式下 stdio 连接直接执行：与 shell_* 同级（Auto 已允许任意本机命令），
  // 刻意不设 requiresConfirmation —— 那是留给 critical 的。改这条要先改策略，不是改测试。
  it('executes a stdio server connect directly in auto mode', async () => {
    const { result, execute } = await runCall(
      MCP_CONNECT_TOOL_NAME,
      'auto',
      { serverId: 'local-tools' },
      { mcpConnectTarget },
    )

    expect(result).toBe('continue')
    expect(execute).toHaveBeenCalledOnce()
  })
})
