import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import type { ModelItem } from '@einfach-agent/ai'
import { itemsAtom, runAtom } from '@einfach-agent/core'
import { contextCheckpointAtom } from '../../../packages/agent-core/src/state/sessionAtoms'
import { runSession } from '../../../packages/agent-core/src/runtime/runToolLoop'
import { createBrowserAgent } from './client'

const clients: Array<Awaited<ReturnType<typeof createBrowserAgent>>> = []
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.dispose())) })

function response(content: string): Response {
  return Response.json({ choices: [{ finish_reason: 'stop', message: {
    role: 'assistant', content, reasoning_content: 'Checked the result.',
  } }] })
}

describe('browser agent compaction through the compatible transport', () => {
  it('continues after compaction and reload without incomplete synthetic assistant messages', async () => {
    const namespace = `compact-compat-${crypto.randomUUID()}`
    const requests: Array<{ messages: ModelItem[]; stream?: boolean }> = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as typeof requests[number]
      requests.push(body)
      if (!body.stream) return response('The large tool result was checked. Continue with the user request.')
      // The live thinking endpoint rejects a tool-call assistant without this field.
      // A permissive mock used to hide the missing field on compact's synthetic call.
      if (body.messages.some((message) => message.role === 'assistant'
        && message.tool_calls?.length && typeof message.reasoning_content !== 'string')) {
        return Response.json({ error: { type: 'invalid_request_error', code: 'invalid_request_error' } }, { status: 400 })
      }
      return response('Done.')
    }
    const client = await createBrowserAgent({ namespace, fetch: fetchImpl })
    clients.push(client)
    const connection = await client.saveConnection({
      label: 'Thinking endpoint', baseUrl: 'https://model.example/v1', models: ['thinking-model'], apiKey: 'test-key',
    })
    const agent = await client.saveAgent({
      name: 'Test', instructions: 'Inspect the result.', connectionId: connection.id,
      model: 'thinking-model', toolNames: ['skill_search'], skillNames: [],
    })
    const sessionId = await client.createSession(agent.id)
    const store = client.core.getSessionStore(sessionId).store
    const originalHistory = [
      { id: 'u1', createdAt: 1, item: { role: 'user' as const, content: 'Inspect the data.' } },
      { id: 'a1', createdAt: 2, item: {
        role: 'assistant' as const, content: '', reasoning_content: 'Read the data first.',
        tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'skill_search', arguments: '{}' } }],
      } },
      { id: 't1', createdAt: 3, item: { role: 'tool' as const, tool_call_id: 'c1', content: 'x'.repeat(240_000) } },
    ]
    store.setter(itemsAtom, originalHistory)
    const run = (current: typeof client, message: string) => runSession(sessionId, message, {
      core: current.core, signal: new AbortController().signal, apiKey: '', fetchImpl: current.core.config.fetchImpl,
    })

    await run(client, 'Continue.')

    expect(store.getter(runAtom)?.error).toBeUndefined()
    expect(store.getter(runAtom)?.status).toBe('done')
    expect(requests).toHaveLength(2)
    const checkpoint = store.getter(contextCheckpointAtom)
    expect(checkpoint?.coveredItemIds).toHaveLength(4)
    expect(store.getter(itemsAtom).slice(0, 3)).toEqual(originalHistory)
    const assertCompactionPair = (messages: ModelItem[]) => {
      const index = messages.findIndex((message) => message.role === 'tool'
        && message.tool_call_id.startsWith('timed:compact:'))
      expect(index).toBeGreaterThan(0)
      const receipt = messages[index]
      if (receipt.role !== 'tool') throw new Error('Expected compact receipt')
      expect(messages[index - 1]).toEqual({
        role: 'assistant', content: '', reasoning_content: '',
        tool_calls: [{ id: receipt.tool_call_id, type: 'function', function: { name: 'timed_tool_result', arguments: '{}' } }],
      })
    }
    assertCompactionPair(requests[1].messages)
    expect(store.getter(itemsAtom).some(({ item }) => item.role === 'assistant'
      && item.tool_calls?.some((call) => call.id.startsWith('timed:')))).toBe(false)

    await client.dispose()
    clients.splice(clients.indexOf(client), 1)
    const restored = await createBrowserAgent({ namespace, fetch: fetchImpl })
    clients.push(restored)
    expect(restored.core.getSessionStore(sessionId).store.getter(contextCheckpointAtom)).toEqual(checkpoint)
    await run(restored, 'Check again.')

    expect(restored.core.getSessionStore(sessionId).store.getter(runAtom)?.status).toBe('done')
    expect(requests).toHaveLength(3)
    assertCompactionPair(requests[2].messages)
  })
})
