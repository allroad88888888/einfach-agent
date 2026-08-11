import { describe, expect, it } from 'vitest'
import type { Tool } from '../tools/types'
import { itemsAtom } from '../state/sessionAtoms'
import { sessionsAtom } from '../state/rootAtoms'
import { createCoreInstance } from './core/coreInstance'
import { handleToolGate } from './toolCallGate'
import { createToolEpoch } from './toolEpoch'
import type { ToolLoopBase } from './toolLoopContracts'
import type { ConversationItem } from '../state/core.type'

const SERVER_TOOL_NAMES = [
  'shell_macos',
  'shell_linux',
  'shell_powershell',
  'write_file',
  'git_diff_review',
] as const

function serverTool(name: string): Tool {
  return {
    name,
    runtime: 'server',
    skill: {
      description: 'run a shell command',
      content: 'Use only with explicit confirmation.',
    },
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
    },
    execute: () => ({ ok: true }),
  }
}

function baseFor(runtimeIsTauri: boolean, name: string): ToolLoopBase {
  const core = createCoreInstance({
    registerTools: (registry) => registry.register(serverTool(name)),
  })
  core.rootStore.setter(sessionsAtom, {
    session: {
      id: 'session',
      title: 'test',
      settings: { vendor: 'deepseek', model: 'test' },
      createdAt: 0,
      updatedAt: 0,
    },
  })

  return {
    id: 'session',
    runId: 'run',
    core,
    toolEpoch: createToolEpoch(core.tools, { sessionId: 'session', runId: 'run' }),
    turnId: 'turn',
    maxTurnTools: 8,
    runtimeIsTauri,
    trace: {
      span: {} as ToolLoopBase['trace']['span'],
      event: () => {},
      finish: () => {},
    },
    state: {
      visible: [],
      recentToolNames: [],
      consecutivePlanTextTurns: 0,
      stageTurnsOnGuard: 0,
    },
  } as unknown as ToolLoopBase
}

function requestServerSchema(base: ToolLoopBase, name: string): void {
  expect(handleToolGate(base, {
    callId: 'schema-call',
    name: 'request_tool_schema',
    args: { toolName: name },
    tools: [],
    expectedRegistrationVersion: undefined,
  })).toBe(true)
}

function toolResultContent(result: ConversationItem): string {
  expect(result.item.role).toBe('tool')
  return result.item.role === 'tool' ? result.item.content : ''
}

describe('handleToolGate server schema visibility', () => {
  it.each(SERVER_TOOL_NAMES)('rejects %s schema requests in Web runtime', (name) => {
    const base = baseFor(false, name)

    requestServerSchema(base, name)

    expect(base.state.visible).toEqual([])
    const [result] = base.core.getSessionStore(base.id).store.getter(itemsAtom)
    expect(JSON.parse(toolResultContent(result))).toEqual({
      error: `tool not allowed for child agent: ${name}`,
    })
  })

  it.each(SERVER_TOOL_NAMES)('loads %s schema in the Tauri runtime', (name) => {
    const base = baseFor(true, name)

    requestServerSchema(base, name)

    expect(base.state.visible.map((tool) => tool.name)).toEqual([name])
    const [result] = base.core.getSessionStore(base.id).store.getter(itemsAtom)
    expect(JSON.parse(toolResultContent(result))).toMatchObject({
      toolName: name,
      loaded: true,
    })
  })
})
