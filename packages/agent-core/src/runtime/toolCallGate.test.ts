import { describe, expect, it, vi } from 'vitest'
import type { Tool } from '../tools/types'
import type { ToolRegistry } from '../tools/toolRegistry'
import { itemsAtom } from '../state/sessionAtoms'
import { sessionsAtom } from '../state/rootAtoms'
import { createCoreInstance } from './core/coreInstance'
import type { RuntimeConfig } from './core/runtimeConfig'
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

interface BaseOptions {
  hostHasLocalCapabilities?: boolean
  registerTools?: (registry: ToolRegistry) => void
  config?: Partial<RuntimeConfig>
}

function makeBase(options: BaseOptions = {}): ToolLoopBase {
  const { hostHasLocalCapabilities = false, registerTools, config } = options
  const core = createCoreInstance({ registerTools, config })
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
    hostHasLocalCapabilities,
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

function baseFor(hostHasLocalCapabilities: boolean, name: string): ToolLoopBase {
  return makeBase({
    hostHasLocalCapabilities,
    registerTools: (registry) => registry.register(serverTool(name)),
  })
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

// B4：按需连接模式下，模型看得到未连接服务【上次已知】的工具清单，于是可能跳过
// connect_mcp_server 直接点名。core 自己判不出「这个名字归谁」——事实由宿主探针给。
describe('handleToolGate unconnected MCP provider', () => {
  const CACHED_TOOL = 'mcp__github__create_issue'
  const CACHED_AT = Date.UTC(2026, 0, 2, 3, 4, 5)

  function probeFor(toolName: string) {
    return vi.fn((name: string) => (
      name === toolName ? { serverId: 'github', cachedAt: CACHED_AT } : undefined
    ))
  }

  function callGate(base: ToolLoopBase, name: string, args: Record<string, unknown>): unknown {
    expect(handleToolGate(base, {
      callId: 'call-1',
      name,
      args,
      tools: [],
      expectedRegistrationVersion: undefined,
    })).toBe(true)
    const [result] = base.core.getSessionStore(base.id).store.getter(itemsAtom)
    return JSON.parse(toolResultContent(result))
  }

  it('tells the model to connect first when it calls a cached tool directly', () => {
    const unconnectedToolProvider = probeFor(CACHED_TOOL)
    const base = makeBase({ config: { unconnectedToolProvider } })

    expect(callGate(base, CACHED_TOOL, { title: 'x' })).toMatchObject({
      code: 'tool_provider_not_connected',
      serverId: 'github',
      executed: false,
      retryable: false,
      lastKnownAt: '2026-01-02T03:04:05.000Z',
      nextCall: { name: 'connect_mcp_server', arguments: { serverId: 'github' } },
    })
    expect(unconnectedToolProvider).toHaveBeenCalledWith(CACHED_TOOL)
  })

  it('answers the same way when the model asks request_tool_schema for it', () => {
    const base = makeBase({ config: { unconnectedToolProvider: probeFor(CACHED_TOOL) } })

    expect(callGate(base, 'request_tool_schema', { toolName: CACHED_TOOL })).toMatchObject({
      code: 'tool_provider_not_connected',
      serverId: 'github',
    })
  })

  it('keeps the schema-not-loaded receipt when no probe is wired', () => {
    const base = makeBase({})

    expect(callGate(base, CACHED_TOOL, {})).toMatchObject({ code: 'tool_schema_not_loaded' })
  })

  it('keeps the schema-not-loaded receipt when the probe cannot place the tool', () => {
    const base = makeBase({ config: { unconnectedToolProvider: probeFor('mcp__other__thing') } })

    expect(callGate(base, CACHED_TOOL, {})).toMatchObject({ code: 'tool_schema_not_loaded' })
  })

  it('does not let a throwing probe crash the call or fabricate a provider', () => {
    const unconnectedToolProvider = vi.fn(() => {
      throw new Error('宿主缓存还没读进来')
    })
    const base = makeBase({ config: { unconnectedToolProvider } })

    expect(callGate(base, CACHED_TOOL, {})).toMatchObject({ code: 'tool_schema_not_loaded' })
    expect(unconnectedToolProvider).toHaveBeenCalledTimes(1)
  })

  it('never consults the probe for a tool this run already knows', () => {
    const unconnectedToolProvider = probeFor('git_diff_review')
    const base = makeBase({
      hostHasLocalCapabilities: true,
      registerTools: (registry) => registry.register(serverTool('git_diff_review')),
      config: { unconnectedToolProvider },
    })

    // 本 run 目录里有它、只是本轮没暴露 → 仍走 lazy autoload，不能被误判成「未连接」。
    expect(callGate(base, 'git_diff_review', { command: 'ls' })).toMatchObject({
      code: 'tool_schema_autoloaded',
    })
    expect(unconnectedToolProvider).not.toHaveBeenCalled()
  })

  it('ignores the probe for a discovery-style request_tool_schema call', () => {
    const unconnectedToolProvider = probeFor(CACHED_TOOL)
    const base = makeBase({ config: { unconnectedToolProvider } })

    callGate(base, 'request_tool_schema', { query: 'issue' })

    expect(unconnectedToolProvider).not.toHaveBeenCalled()
  })
})
