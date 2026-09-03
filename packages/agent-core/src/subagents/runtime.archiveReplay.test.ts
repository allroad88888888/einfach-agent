import { describe, expect, it, vi } from 'vitest'
import { replaySubagentArchive } from '../../../subagents/src/archive/replay'
import { context, namedToolCall, requestBody, response } from './runtime.testHarness'
import { createTestDelegationRuntime } from './runtime.ports.testFixtures'

describe('createDelegationRuntime archive replay', () => {
  it('replays a real terminal event with non-empty change sets', async () => {
    const writes = new Map<string, string>()
    const runChildTool = vi.fn(async () => ({
      ok: true as const,
      data: { changeSet: { id: 'child-change-01', reversible: true } },
    }))
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      const messages = body.messages as Array<{ role: string }>
      return messages.some((message) => message.role === 'tool')
        ? response({ content: 'write complete' })
        : namedToolCall('write-change', 'write_file', { path: 'a.txt', content: 'ok' })
    }
    const callContext = context(writes)
    callContext.runChildTool = runChildTool
    callContext.dangerousToolCapability = {
      sessionId: 'session', runId: 'run-archive-replay', delegationCallId: 'delegate-archive-replay',
      parentPath: 'root', toolNames: ['write_file'],
    }
    callContext.delegationCallId = 'delegate-archive-replay'
    const runtime = createTestDelegationRuntime({
      sessionId: 'session', runId: 'run-archive-replay', settings: { vendor: 'deepseek', model: 'test-model' },
      hostHasLocalCapabilities: true, apiKey: 'test-key', signal: new AbortController().signal, fetchImpl,
    })

    const online = await runtime.delegateAgents({
      children: [{ objective: 'write', confirmedTools: ['write_file'] }], confirmedTools: ['write_file'],
    }, callContext)
    const eventsText = [...writes.entries()].find(([path]) => path.endsWith('/events.jsonl'))?.[1] ?? ''
    const events = eventsText.trim().split('\n').map((line) => JSON.parse(line) as { type: string; data?: Record<string, unknown> })
    const terminal = events.find((event) => event.type === 'child_finished')
    const replayed = replaySubagentArchive({ eventsText })

    expect(terminal?.data).toMatchObject({ child_payload_version: 1, changeSets: online.children[0]?.changeSets })
    expect(replayed.childResults[0]?.changeSets).toEqual(online.children[0]?.changeSets)
    await runtime.dispose?.()
  })
})
