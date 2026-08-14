import { describe, expect, it } from 'vitest'
import { itemsAtom, runAtom } from '../../state/sessionAtoms'
import { createCore } from '../core/createCore'

describe('stopRun tool-call interruption', () => {
  it('marks uncompleted calls outcomeUnknown without inventing a tool receipt', () => {
    const core = createCore()
    const id = core.newSession()
    const store = core.getSessionStore(id).store
    store.setter(itemsAtom, [
      { id: 'u1', createdAt: 1, item: { role: 'user' as const, content: '执行检查' } },
      {
        id: 'a1',
        createdAt: 2,
        item: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [
            { id: 'completed', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } },
            { id: 'pending', type: 'function' as const, function: { name: 'shell_macos', arguments: '{"command":"pwd"}' } },
          ],
        },
      },
      { id: 't1', createdAt: 3, item: { role: 'tool' as const, tool_call_id: 'completed', content: '{"ok":true}' } },
    ])
    store.setter(runAtom, { runId: 'run-1', turnId: 'u1', status: 'running' })

    core.stopRun()
    core.stopRun()

    const pendingResults = store.getter(itemsAtom)
      .filter(({ item }) => item.role === 'tool' && item.tool_call_id === 'pending')
    expect(pendingResults).toHaveLength(0)
    expect(store.getter(runAtom)).toMatchObject({
      status: 'stopped',
      toolCallOutcomes: {
        pending: { state: 'outcomeUnknown' },
      },
    })
  })

  it('requires reconciliation for an older stopped run with no durable call fact', async () => {
    let requestMessages: Array<Record<string, unknown>> = []
    const core = createCore({
      config: {
        modelCredentials: { deepseek: 'test-key' },
        fetchImpl: async (_url, init) => {
          requestMessages = (JSON.parse(String(init?.body)) as { messages: Array<Record<string, unknown>> }).messages
          return new Response('unexpected model request', { status: 500 })
        },
      },
    })
    const id = core.newSession()
    const store = core.getSessionStore(id).store
    store.setter(itemsAtom, [
      { id: 'u1', createdAt: 1, item: { role: 'user' as const, content: '执行检查' } },
      {
        id: 'a1',
        createdAt: 2,
        item: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [
            { id: 'completed', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } },
            { id: 'pending', type: 'function' as const, function: { name: 'shell_macos', arguments: '{"command":"pwd"}' } },
          ],
        },
      },
      { id: 't1', createdAt: 3, item: { role: 'tool' as const, tool_call_id: 'completed', content: '{"ok":true}' } },
    ])
    store.setter(runAtom, { runId: 'run-1', turnId: 'u1', status: 'stopped' })

    await expect(core.sendMessage('继续')).resolves.toMatchObject({
      accepted: false,
      reason: 'run_blocked',
    })
    expect(requestMessages).toEqual([])
    expect(store.getter(itemsAtom)
      .filter(({ item }) => item.role === 'tool' && item.tool_call_id === 'pending'))
      .toHaveLength(0)
  })
})
