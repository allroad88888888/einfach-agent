// 「一次工具调用会不会被拦下来」这一族测试共用的脚手架。
//
// 单一职责：把「造一个只装了目标工具的 core、按给定授权模式起一个 run、跑真的
// runToolCallBatch、再交回 result / execute / run 三样可断言的事实」这套样板集中在一处。
// 这里不含任何判据，判据都在各自的 *.test.ts 里。

import { vi } from 'vitest'
import type { ModelFunctionTool, ModelToolCall } from '@web-agent/ai'
import { sessionsAtom } from '../state/rootAtoms'
import { runAtom } from '../state/sessionAtoms'
import { alwaysAllowedToolsAtom } from '../state/transientAtoms'
import { setRun } from '../state/sessionWriters'
import { createCoreInstance, type RuntimeConfig } from './core/coreInstance'
import type { Tool } from '../tools/types'
import type { ToolLoopBase } from './toolLoopContracts'
import { runToolCallBatch } from './toolCallBatch'
import { createToolEpoch } from './toolEpoch'
import type { ModelTurnResult } from './modelTurnRequester'

export type ApprovalMode = 'confirm' | 'auto'

function createTestTool(name: string, execute: Tool['execute']): Tool {
  return {
    name,
    runtime: 'server',
    skill: { description: 'Test tool', content: 'Test-only tool.' },
    inputSchema: { type: 'object', additionalProperties: true },
    execute,
  }
}

export function createHarness(
  name: string,
  approvalMode: ApprovalMode,
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
      settings: { vendor: 'test-vendor', model: 'test-model' },
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

export async function runCall(
  name: string,
  approvalMode: ApprovalMode,
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
