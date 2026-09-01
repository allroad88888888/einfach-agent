import { describe, expect, it, vi } from 'vitest'
import type { AgentHistoryCapability, AgentHistoryCapabilityProvider } from '../history'
import { SUBAGENT_HISTORY_TOOLS } from '../subagents/historyToolProfile'
import type { SubagentToolProfile } from '../subagents/types'
import { createCoreInstance } from './core/coreInstance'
import { buildToolContext } from './toolContext'
import {
  delegateRuntimeCapturing,
  runDelegation,
  seedSession,
} from './toolContext.workspaceRoot.testHarness'

const profiles: SubagentToolProfile[] = ['delegate_only', 'workspace_read', 'workspace_verify']

function historyCapability(): AgentHistoryCapability {
  return {
    async listHistories() { return { histories: [], warnings: [] } },
    async listItems() { throw new Error('unused') },
    async readItem() { throw new Error('unused') },
    async search() { return { hits: [], warnings: [] } },
  }
}

describe('ToolContext child history profile gate', () => {
  it.each(profiles)('%s executes all history tools without confirmed capability', async (profile) => {
    const core = createCoreInstance()
    const capability = historyCapability()
    const provider = { forContext: vi.fn(() => capability) } satisfies AgentHistoryCapabilityProvider
    const execute = vi.fn((_args, ctx) => ({ ok: true as const, data: { same: ctx.agentHistory === capability } }))
    for (const name of SUBAGENT_HISTORY_TOOLS) {
      core.tools.register({
        name, runtime: 'internal', skill: { description: name, content: name },
        inputSchema: { type: 'object', additionalProperties: false }, execute,
      })
    }
    seedSession('history-child', '/workspace/history', undefined, core)
    core.persistence.configure({ agentHistory: provider })
    const results: unknown[] = []
    const delegateRuntime = delegateRuntimeCapturing(async (callContext) => {
      for (const name of SUBAGENT_HISTORY_TOOLS) {
        results.push(await callContext.runChildTool?.(
          name,
          {},
          core.tools.registrationVersion(name),
        ))
      }
    }, 'history-child')
    const ctx = buildToolContext({
      sessionId: 'history-child', runId: 'r', callId: 'delegate-call',
      toolName: 'delegate_agent', toolArgs: { children: [{ objective: 'inspect' }], toolProfile: profile },
      signal: new AbortController().signal, delegateRuntime, core,
    })

    await runDelegation(ctx, { children: [{ objective: 'inspect' }], toolProfile: profile })

    expect(results).toEqual(SUBAGENT_HISTORY_TOOLS.map(() => ({ ok: true, data: { same: true } })))
    expect(execute).toHaveBeenCalledTimes(4)
    expect(provider.forContext).toHaveBeenCalledWith({ legacyWorkspaceRoot: '/workspace/history' })
  })

  it('does not promote unrelated tools in delegate_only', async () => {
    const core = createCoreInstance()
    seedSession('history-fail-closed', '/workspace', undefined, core)
    core.tools.register({
      name: 'write_file', runtime: 'server', skill: { description: 'write', content: 'write' },
      inputSchema: { type: 'object' }, execute: () => ({ ok: true }),
    })
    let result: unknown
    const ctx = buildToolContext({
      sessionId: 'history-fail-closed', runId: 'r', callId: 'delegate-call',
      toolName: 'delegate_agent', signal: new AbortController().signal, core,
      delegateRuntime: delegateRuntimeCapturing(async (callContext) => {
        result = await callContext.runChildTool?.('write_file', {})
      }, 'history-fail-closed'),
    })

    await runDelegation(ctx, { children: [{ objective: 'inspect' }], toolProfile: 'delegate_only' })
    expect(result).toEqual({ ok: false, error: 'tool not allowed for child agent: write_file' })
  })

  it('fails closed at the execution gate for an unknown profile', async () => {
    const core = createCoreInstance()
    seedSession('history-unknown-profile', '/workspace', undefined, core)
    const name = SUBAGENT_HISTORY_TOOLS[0]
    core.tools.register({
      name, runtime: 'internal', skill: { description: name, content: name },
      inputSchema: { type: 'object' }, execute: () => ({ ok: true }),
    })
    let result: unknown
    const unknownProfile = 'unknown' as SubagentToolProfile
    const ctx = buildToolContext({
      sessionId: 'history-unknown-profile', runId: 'r', callId: 'delegate-call',
      toolName: 'delegate_agent', toolArgs: { children: [{ objective: 'inspect' }], toolProfile: unknownProfile },
      signal: new AbortController().signal, core,
      delegateRuntime: delegateRuntimeCapturing(async (callContext) => {
        result = await callContext.runChildTool?.(name, {})
      }, 'history-unknown-profile'),
    })

    await runDelegation(ctx, { children: [{ objective: 'inspect' }], toolProfile: unknownProfile })
    expect(result).toEqual({ ok: false, error: `tool not allowed for child agent: ${name}` })
  })
})
