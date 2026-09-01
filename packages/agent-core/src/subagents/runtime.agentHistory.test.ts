import { describe, expect, it, vi } from 'vitest'
import type { Tool } from '../tools/types'
import { createToolRegistry } from '../tools/toolRegistry'
import { SUBAGENT_HISTORY_TOOLS } from './historyToolProfile'
import type { DelegateAgentCallContext, SubagentToolProfile } from './types'
import { createTestDelegationRuntime } from './runtime.ports.testFixtures'
import { childPath, namedToolCall, requestBody, response, toolResultFor } from './runtime.testHarness'

const profiles: SubagentToolProfile[] = ['delegate_only', 'workspace_read', 'workspace_verify']

function tool(name: string): Tool {
  return {
    name, runtime: 'internal', skill: { description: `${name} description`, content: `${name} guide` },
    inputSchema: { type: 'object', additionalProperties: false },
    execute: () => ({ ok: true, data: { name } }),
  }
}

function context(runChildTool: NonNullable<DelegateAgentCallContext['runChildTool']>): DelegateAgentCallContext {
  return {
    parentPath: 'root', parentTranscript: 'root', progress() {}, runChildTool,
    async writeTextFile() { return { ok: true } },
  }
}

describe('child runtime agent history visibility', () => {
  it.each(profiles)('%s exposes and executes all four read-only history tools', async (profile) => {
    const registry = createToolRegistry()
    for (const name of SUBAGENT_HISTORY_TOOLS) registry.register(tool(name))
    let childTurn = 0
    let firstTurnNames: string[] = []
    const selected = SUBAGENT_HISTORY_TOOLS[profiles.indexOf(profile)] ?? SUBAGENT_HISTORY_TOOLS[3]
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { source: selected } }))
    const delegateRuntime = createTestDelegationRuntime({
      sessionId: 'session', runId: `history-${profile}`,
      settings: { vendor: 'deepseek', model: 'deepseek-v4-pro' },
      apiKey: 'test-key', signal: new AbortController().signal,
      hostHasLocalCapabilities: false, registry,
      fetchImpl: async (_url, init) => {
        const body = requestBody(init)
        if (!childPath(body)) return response({ content: '# distilled history skill' })
        childTurn += 1
        if (childTurn === 1) {
          firstTurnNames = (body.tools as Array<{ function: { name: string } }>)
            .map((entry) => entry.function.name)
          return namedToolCall('history-call', selected, {})
        }
        expect(JSON.parse(toolResultFor(body, 'history-call'))).toEqual({ source: selected })
        return response({ content: 'history inspected' })
      },
    })

    const result = await delegateRuntime.delegateAgents({
      toolProfile: profile,
      children: [{ objective: 'inspect local history', maxTurns: 3 }],
    }, context(runChildTool))

    expect(firstTurnNames).toEqual(expect.arrayContaining([...SUBAGENT_HISTORY_TOOLS]))
    expect(runChildTool).toHaveBeenCalledWith(selected, {}, expect.any(Number))
    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'history inspected' })
    await delegateRuntime.dispose?.()
  })
})
