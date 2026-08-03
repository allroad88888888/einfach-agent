import { describe, expect, it } from 'vitest'
import type { Tool } from '../tools/types'
import { itemsAtom } from '../state/sessionAtoms'
import { sessionsAtom } from '../state/rootAtoms'
import { createCoreInstance } from './core/coreInstance'
import { handleToolGate } from './toolCallGate'
import type { ToolLoopBase } from './toolLoopContracts'

function serverTool(): Tool {
  return {
    name: 'shell_macos',
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

function baseFor(runtimeIsTauri: boolean): ToolLoopBase {
  const core = createCoreInstance({
    registerTools: (registry) => registry.register(serverTool()),
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

function requestServerSchema(base: ToolLoopBase): void {
  expect(handleToolGate(base, {
    callId: 'schema-call',
    name: 'request_tool_schema',
    args: { toolName: 'shell_macos' },
    tools: [],
    expectedRegistrationVersion: undefined,
  })).toBe(true)
}

describe('handleToolGate server schema visibility', () => {
  it('rejects a server-tool schema request in Web runtime', () => {
    const base = baseFor(false)

    requestServerSchema(base)

    expect(base.state.visible).toEqual([])
    const [result] = base.core.getSessionStore(base.id).store.getter(itemsAtom)
    expect(JSON.parse(result.item.content ?? '')).toEqual({
      error: 'tool not allowed for child agent: shell_macos',
    })
  })

  it('loads the same schema in the Tauri runtime', () => {
    const base = baseFor(true)

    requestServerSchema(base)

    expect(base.state.visible.map((tool) => tool.name)).toEqual(['shell_macos'])
    const [result] = base.core.getSessionStore(base.id).store.getter(itemsAtom)
    expect(JSON.parse(result.item.content ?? '')).toMatchObject({
      toolName: 'shell_macos',
      loaded: true,
    })
  })
})
