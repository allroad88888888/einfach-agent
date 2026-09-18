import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { itemsAtom, runAtom } from '@einfach-agent/core'
import type { ToolRegistry } from '@einfach-agent/core/tools'
import { createBrowserAgent } from './client'

type Client = Awaited<ReturnType<typeof createBrowserAgent>>
const clients: Client[] = []

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.dispose()))
})

function namespace(label: string): string {
  return `${label}-${crypto.randomUUID()}`
}

async function configuredClient(
  name: string,
  options: { fetch?: typeof fetch; registerTools?: (registry: ToolRegistry) => void } = {},
) {
  const client = await createBrowserAgent({ namespace: name, ...options })
  clients.push(client)
  const connection = await client.saveConnection({
    label: 'primary', baseUrl: 'https://model.example/v1', models: ['m'], apiKey: 'key',
  })
  const agent = await client.saveAgent({
    name: 'Agent', instructions: 'stay scoped', connectionId: connection.id,
    model: 'm', toolNames: [], skillNames: [],
  })
  return { client, agent }
}

function response(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('recoverable host close', () => {
  it('rejects a real recovery-writer error, reuses the promise, and retains namespace ownership', async () => {
    const name = namespace('recovery-write-error')
    const { client, agent } = await configuredClient(name)
    await client.createSession(agent.id)
    clients.splice(clients.indexOf(client), 1)
    const loadLatest = vi.fn(async () => { throw new Error('recovery driver unavailable') })
    client.core.persistence.configure({
      recovery: {
        listLatest: async () => [],
        loadLatest,
        saveLatest: async (_sessionId, snapshot) => ({ status: 'saved' as const, generation: snapshot.generation }),
        deleteSession: async () => undefined,
      },
    })

    const disposing = client.dispose({ preserveRecovery: true })
    expect(client.dispose()).toBe(disposing)
    await expect(disposing).rejects.toThrow('Host shutdown recovery was not durably saved')
    expect(loadLatest).toHaveBeenCalled()
    await expect(createBrowserAgent({ namespace: name })).rejects.toThrow('already has an owner')
  })

  it('closes only A, lets B finish, then rebuilds and resumes A', async () => {
    const pendingA: Array<{ signal?: AbortSignal; resolve(response: Response): void }> = []
    const pendingB: Array<{ signal?: AbortSignal; resolve(response: Response): void }> = []
    let aRequests = 0
    const fetchA: typeof fetch = async (_input, init) => {
      aRequests += 1
      if (aRequests > 1) return response('A recovered')
      return new Promise<Response>((resolve) => pendingA.push({ signal: init?.signal ?? undefined, resolve }))
    }
    const fetchB: typeof fetch = async (_input, init) => new Promise<Response>((resolve) => {
      pendingB.push({ signal: init?.signal ?? undefined, resolve })
    })
    const nameA = namespace('isolated-a')
    const { client: clientA, agent: agentA } = await configuredClient(nameA, { fetch: fetchA })
    const { client: clientB, agent: agentB } = await configuredClient(namespace('isolated-b'), { fetch: fetchB })
    const sessionA = await clientA.createSession(agentA.id)
    const sessionB = await clientB.createSession(agentB.id)
    await Promise.all([
      clientA.core.sendMessage('pending A', { sessionId: sessionA }),
      clientB.core.sendMessage('pending B', { sessionId: sessionB }),
    ])
    for (let attempt = 0; attempt < 100 && (!pendingA.length || !pendingB.length); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    await clientA.dispose({ preserveRecovery: true })
    clients.splice(clients.indexOf(clientA), 1)
    expect(pendingA[0]?.signal?.aborted).toBe(true)
    expect(pendingB[0]?.signal?.aborted).toBe(false)
    pendingB[0]?.resolve(response('B finished'))
    for (let attempt = 0; attempt < 100 && clientB.core.getSessionStore(sessionB).store.getter(runAtom)?.status !== 'done'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(clientB.core.getSessionStore(sessionB).store.getter(runAtom)?.status).toBe('done')

    const restoredA = await createBrowserAgent({ namespace: nameA, fetch: fetchA })
    clients.push(restoredA)
    expect(restoredA.core.getSessionRecoveryStatus(sessionA)).toMatchObject({ status: 'recoverable' })
    expect(restoredA.core.continueRecoveredSession(sessionA)).toMatchObject({ status: 'continued' })
    for (let attempt = 0; attempt < 100 && restoredA.core.getSessionStore(sessionA).store.getter(runAtom)?.status !== 'done'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(restoredA.core.getSessionStore(sessionA).store.getter(runAtom)?.status).toBe('done')
  })

  it('rebuilds a paused confirmation without losing its decision payload', async () => {
    const name = namespace('paused-rebuild')
    const { client, agent } = await configuredClient(name)
    const sessionId = await client.createSession(agent.id)
    const store = client.core.getSessionStore(sessionId).store
    store.setter(itemsAtom, [{
      id: 'assistant', createdAt: 1,
      item: { role: 'assistant', content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: 'external_write', arguments: '{}' } }] },
    }])
    store.setter(runAtom, {
      runId: 'paused', status: 'waiting_confirmation',
      pendingToolConfirmation: { callId: 'call', toolName: 'external_write', args: {}, reason: 'writes externally' },
    })

    await client.dispose({ preserveRecovery: true })
    clients.splice(clients.indexOf(client), 1)
    const restored = await createBrowserAgent({ namespace: name })
    clients.push(restored)
    expect(restored.core.getSessionRecoveryStatus(sessionId)).toEqual({
      status: 'awaiting_user', sessionId, waitingFor: 'waiting_confirmation',
    })
    expect(restored.core.getSessionStore(sessionId).store.getter(runAtom)?.pendingToolConfirmation)
      .toMatchObject({ callId: 'call', toolName: 'external_write', reason: 'writes externally' })
  })

  it('rebuilds an unknown external write as reconciliation-required without replay', async () => {
    const name = namespace('unknown-rebuild')
    const fetchImpl = vi.fn(async () => response('must not run'))
    const execute = vi.fn(() => ({ ok: true as const, data: { written: true } }))
    const registerTools = (registry: ToolRegistry) => registry.register({
      name: 'external_write', runtime: 'internal', execution: { mode: 'serial', effectKeys: ['external'] },
      skill: { description: 'external write', triggers: [], content: 'external write' },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute,
    })
    const { client, agent } = await configuredClient(name, { fetch: fetchImpl, registerTools })
    const sessionId = await client.createSession(agent.id)
    const store = client.core.getSessionStore(sessionId).store
    store.setter(itemsAtom, [
      { id: 'user', createdAt: 1, item: { role: 'user', content: 'write' } },
      { id: 'assistant', createdAt: 2, item: { role: 'assistant', content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: 'external_write', arguments: '{}' } }] } },
    ])
    store.setter(runAtom, {
      runId: 'unknown', turnId: 'user', status: 'running',
      toolCallOutcomes: { call: { state: 'outcomeUnknown', updatedAt: 2 } },
    })

    await client.dispose({ preserveRecovery: true })
    clients.splice(clients.indexOf(client), 1)
    const restored = await createBrowserAgent({ namespace: name, fetch: fetchImpl, registerTools })
    clients.push(restored)
    expect(restored.core.getSessionRecoveryStatus(sessionId)).toEqual({
      status: 'reconciliation_required', sessionId, reason: 'tool_outcome',
    })
    expect(restored.core.continueRecoveredSession(sessionId)).toMatchObject({ status: 'reconciliation_required' })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })
})
