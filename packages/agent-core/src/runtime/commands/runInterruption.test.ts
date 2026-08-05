import { describe, expect, it } from 'vitest'
import { itemsAtom, runAtom } from '../../state/sessionAtoms'
import { createCore } from '../core/createCore'

function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('stopRun tool-call closure', () => {
  it('closes uncompleted calls before the next model request', async () => {
    let requestMessages: Array<Record<string, unknown>> = []
    const core = createCore({
      config: {
        deepseekApiKey: 'test-key',
        fetchImpl: async (_url, init) => {
          requestMessages = (JSON.parse(String(init?.body)) as { messages: Array<Record<string, unknown>> }).messages
          return jsonResponse('已恢复')
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
    store.setter(runAtom, { runId: 'run-1', turnId: 'u1', status: 'running' })

    core.stopRun()
    core.stopRun()

    const pendingResults = store.getter(itemsAtom)
      .filter(({ item }) => item.role === 'tool' && item.tool_call_id === 'pending')
    expect(pendingResults).toHaveLength(1)
    expect(pendingResults[0]?.item).toMatchObject({
      role: 'tool',
      tool_call_id: 'pending',
      content: expect.stringContaining('"interrupted":true'),
    })
    expect(store.getter(runAtom)).toMatchObject({ status: 'stopped' })

    core.sendMessage('继续')
    await waitUntil(() => store.getter(runAtom)?.status === 'done', 'follow-up completion')
    expect(requestMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'pending',
        content: expect.stringContaining('"interrupted":true'),
      }),
    ]))
  })
})
