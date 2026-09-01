import { describe, expect, it, vi } from 'vitest'
import type {
  AgentHistoryCapability,
  AgentHistoryCapabilityProvider,
} from '../../history'
import { sessionsAtom } from '../../state/rootStore'
import type { Tool } from '../../tools/types'
import { createCoreInstance } from '../core/coreInstance'
import { buildToolContext } from '../toolContext'
import { createHistoryCapabilities } from './historyCapabilities'

function capability(label: string): AgentHistoryCapability {
  const empty = { warnings: [] as const }
  return {
    async listHistories() { return { histories: [], ...empty, label } },
    async listItems() { throw new Error('unused') },
    async readItem() { throw new Error('unused') },
    async search() { return { hits: [], ...empty } },
  }
}

function provider(value: AgentHistoryCapability): AgentHistoryCapabilityProvider {
  return { forContext: vi.fn(() => value) }
}

function seed(core: ReturnType<typeof createCoreInstance>, workspaceRoot: string): void {
  core.rootStore.setter(sessionsAtom, {
    session: {
      id: 'session', title: 'history', workspaceRoot,
      settings: { vendor: 'deepseek', model: 'test' }, createdAt: 1, updatedAt: 1,
    },
  })
}

function context(core: ReturnType<typeof createCoreInstance>, toolName = 'outer') {
  return buildToolContext({
    sessionId: 'session', runId: 'run', callId: 'call', toolName,
    signal: new AbortController().signal, core,
  })
}

describe('agent history ToolContext binding', () => {
  it('omits the capability when no provider exists', () => {
    expect(createHistoryCapabilities(undefined, '/workspace')).toEqual({})
  })

  it('isolates providers across cores and binds each resolved workspace root', () => {
    const firstCapability = capability('first')
    const secondCapability = capability('second')
    const firstProvider = provider(firstCapability)
    const secondProvider = provider(secondCapability)
    const first = createCoreInstance()
    const second = createCoreInstance()
    const absent = createCoreInstance()
    seed(first, ' /workspace/first ')
    seed(second, '/workspace/second')
    seed(absent, '/workspace/absent')
    first.persistence.configure({ agentHistory: firstProvider })
    second.persistence.configure({ agentHistory: secondProvider })

    expect(context(first).agentHistory).toBe(firstCapability)
    expect(context(second).agentHistory).toBe(secondCapability)
    expect(context(absent).agentHistory).toBeUndefined()
    expect(firstProvider.forContext).toHaveBeenCalledWith({ legacyWorkspaceRoot: '/workspace/first' })
    expect(secondProvider.forContext).toHaveBeenCalledWith({ legacyWorkspaceRoot: '/workspace/second' })
  })

  it('recursive callTool stays on the same core provider', async () => {
    const history = capability('recursive')
    const core = createCoreInstance()
    seed(core, '/workspace')
    core.persistence.configure({ agentHistory: provider(history) })
    const execute = vi.fn((_args: unknown, ctx: Parameters<Tool['execute']>[1]) => ({
      ok: true as const,
      data: { sameCapability: ctx.agentHistory === history },
    }))
    core.tools.register({
      name: 'inner', runtime: 'internal',
      skill: { description: 'inner', content: 'inner' },
      inputSchema: { type: 'object', additionalProperties: false }, execute,
    })

    await expect(context(core).callTool('inner', {})).resolves.toEqual({
      ok: true, data: { sameCapability: true },
    })
    expect(execute).toHaveBeenCalledOnce()
  })
})
