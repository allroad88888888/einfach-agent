import { describe, expect, it, vi } from 'vitest'
import type { ModelFunctionTool, ModelToolCall } from '@web-agent/ai'
import { sessionsAtom } from '../state/rootAtoms'
import { runAtom } from '../state/sessionAtoms'
import { setRun } from '../state/sessionWriters'
import { createCoreInstance } from './core/coreInstance'
import type { Tool } from '../tools/types'
import type { ToolLoopBase } from './toolLoopContracts'
import { runToolCallBatch } from './toolCallBatch'
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

function createHarness(name: string, approvalMode: 'confirm' | 'auto') {
  const execute = vi.fn(async () => ({ ok: true as const, data: { completed: true } }))
  const core = createCoreInstance({
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

  const base = {
    id: 'session',
    runId: 'run',
    turnId: 'turn',
    core,
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
) {
  const { base, execute, core } = createHarness(name, approvalMode)
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
