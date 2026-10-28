import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolRegistry } from '@einfach-agent/core/tools'
import { itemsAtom, pendingArtifactsAtom, pendingQuestionAnswersAtom, runAtom } from '@einfach-agent/core'
import { createBrowserAgent } from './client'
import { addPendingArtifact } from '../../../packages/agent-core/src/state/sessionTransientMutations'

const clients: Array<Awaited<ReturnType<typeof createBrowserAgent>>> = []
afterEach(async () => Promise.all(clients.splice(0).map((client) => client.dispose())))

function registerNamedTools(registry: ToolRegistry): void {
  for (const name of ['tool-a', 'tool-b', 'tool-c']) registry.register({
    name, runtime: 'internal', execution: { mode: 'parallel', effectKeys: [] },
    skill: { description: `only ${name}`, triggers: [], content: name },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => ({ ok: true, data: { name } }),
  })
}

async function waitForRunsDone(runs: ReadonlyArray<{ label: string; store: ReturnType<Awaited<ReturnType<typeof createBrowserAgent>>['core']['getSessionStore']>['store'] }>): Promise<void> {
  const pending = () => runs.filter(({ store }) => store.getter(runAtom)?.status !== 'done')
  if (pending().length === 0) return
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const unsubscribes: Array<() => void> = []
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      unsubscribes.forEach((unsubscribe) => unsubscribe())
      error ? reject(error) : resolve()
    }
    const check = () => { if (pending().length === 0) finish() }
    runs.forEach(({ store }) => {
      const unsubscribe = store.sub(runAtom, check)
      settled ? unsubscribe() : unsubscribes.push(unsubscribe)
    })
    timeout = setTimeout(() => finish(new Error(`runs did not finish: ${pending().map(({ label, store }) => `${label}=${store.getter(runAtom)?.status ?? 'missing'}`).join(', ')}`)), 20_000)
    check()
  })
}

// These integration tests perform asynchronous persistence and model runs on shared CI workers.
vi.setConfig({ testTimeout: 30_000 })

describe('multi-client Agent isolation', () => {
  it('runs three Agents across two clients without crossing endpoint, model, prompt, tools, or key', async () => {
    const requests: Array<{ url: string; auth: string; body: string }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') ?? '', body: String(init?.body) })
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const first = await createBrowserAgent({ namespace: `multi-one-${crypto.randomUUID()}`, fetch: fetchImpl, registerTools: registerNamedTools })
    const second = await createBrowserAgent({ namespace: `multi-two-${crypto.randomUUID()}`, fetch: fetchImpl, registerTools: registerNamedTools })
    clients.push(first, second)
    const one = await first.saveConnection({ label: 'one', baseUrl: 'https://one.example/v1', models: ['model-a'], apiKey: 'key-a' })
    const two = await first.saveConnection({ label: 'two', baseUrl: 'https://two.example/v1', models: ['model-b'], apiKey: 'key-b' })
    const three = await second.saveConnection({ label: 'three', baseUrl: 'https://three.example/v1', models: ['model-c'], apiKey: 'key-c' })
    const agentA = await first.saveAgent({ name: 'A', instructions: 'INSTRUCTION_A', connectionId: one.id, model: 'model-a', toolNames: ['tool-a'], skillNames: [] })
    const agentB = await first.saveAgent({ name: 'B', instructions: 'INSTRUCTION_B', connectionId: two.id, model: 'model-b', toolNames: ['tool-b'], skillNames: [] })
    const agentC = await second.saveAgent({ name: 'C', instructions: 'INSTRUCTION_C', connectionId: three.id, model: 'model-c', toolNames: ['tool-c'], skillNames: [] })
    const sessionA = await first.createSession(agentA.id)
    const sessionB = await first.createSession(agentB.id)
    const sessionC = await second.createSession(agentC.id)

    first.core.selectSession(sessionB)
    await Promise.all([
      first.core.sendMessage('to A', { sessionId: sessionA }),
      first.core.sendMessage('to B', { sessionId: sessionB }),
      second.core.sendMessage('to C', { sessionId: sessionC }),
    ])
    await waitForRunsDone([
      { label: 'A', store: first.core.getSessionStore(sessionA).store },
      { label: 'B', store: first.core.getSessionStore(sessionB).store },
      { label: 'C', store: second.core.getSessionStore(sessionC).store },
    ])
    expect(requests).toHaveLength(3)
    const byUrl = Object.fromEntries(requests.map((request) => [request.url, request]))
    for (const [host, model, instruction, tool, key] of [
      ['one', 'model-a', 'INSTRUCTION_A', 'tool-a', 'key-a'],
      ['two', 'model-b', 'INSTRUCTION_B', 'tool-b', 'key-b'],
      ['three', 'model-c', 'INSTRUCTION_C', 'tool-c', 'key-c'],
    ]) {
      const request = byUrl[`https://${host}.example/v1/chat/completions`]
      expect(request.auth).toBe(`Bearer ${key}`)
      expect(JSON.parse(request.body).model).toBe(model)
      expect(request.body).toContain(instruction)
      expect(request.body).toContain(tool)
      for (const other of ['tool-a', 'tool-b', 'tool-c'].filter((name) => name !== tool)) expect(request.body).not.toContain(other)
    }
    expect(first.getSnapshot().connections.every((connection) => !('apiKey' in connection))).toBe(true)
    expect(second.getSnapshot().connections.every((connection) => !('apiKey' in connection))).toBe(true)
  })

  it('targets A lifecycle and recovery while B is selected and another client stays untouched', async () => {
    let requestCount = 0
    const fetchImpl: typeof fetch = async () => {
      requestCount += 1
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'continued' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const first = await createBrowserAgent({ namespace: `lifecycle-one-${crypto.randomUUID()}`, fetch: fetchImpl })
    const second = await createBrowserAgent({ namespace: `lifecycle-two-${crypto.randomUUID()}`, fetch: fetchImpl })
    clients.push(first, second)
    const connectionA = await first.saveConnection({ label: 'a', baseUrl: 'https://a.example/v1', models: ['m'], apiKey: 'a' })
    const connectionC = await second.saveConnection({ label: 'c', baseUrl: 'https://c.example/v1', models: ['m'], apiKey: 'c' })
    const agentA = await first.saveAgent({ name: 'A', instructions: 'A', connectionId: connectionA.id, model: 'm', toolNames: [], skillNames: [] })
    const agentB = await first.saveAgent({ name: 'B', instructions: 'B', connectionId: connectionA.id, model: 'm', toolNames: [], skillNames: [] })
    const agentC = await second.saveAgent({ name: 'C', instructions: 'C', connectionId: connectionC.id, model: 'm', toolNames: [], skillNames: [] })
    const a = await first.createSession(agentA.id)
    const b = await first.createSession(agentB.id)
    const c = await second.createSession(agentC.id)
    first.core.selectSession(b)
    const aStore = first.core.getSessionStore(a).store
    const bStore = first.core.getSessionStore(b).store
    const cStore = second.core.getSessionStore(c).store

    addPendingArtifact(a, { id: 'one', filename: 'one.txt', content: 'one' }, first.core)
    addPendingArtifact(a, { id: 'two', filename: 'two.txt', content: 'two' }, first.core)
    expect(first.core.undoTurn(a).ok).toBe(true)
    expect(first.core.redoTurn(a).ok).toBe(true)
    expect(bStore.getter(pendingArtifactsAtom)).toEqual([])
    expect(cStore.getter(pendingArtifactsAtom)).toEqual([])

    aStore.setter(itemsAtom, [
      { id: 'u', createdAt: 1, item: { role: 'user', content: 'question' } },
      { id: 'ask', createdAt: 2, item: { role: 'assistant', content: null, tool_calls: [{ id: 'ask-call', type: 'function', function: { name: 'ask_user_question', arguments: '{}' } }] } },
    ])
    aStore.setter(runAtom, { runId: 'waiting', status: 'waiting_user', pendingQuestion: { questions: [{ id: 'q' }] } })
    first.core.answerQuestion('q', 'answer-a', a)
    expect(aStore.getter(pendingQuestionAnswersAtom)).toEqual({ q: 'answer-a' })
    expect(bStore.getter(pendingQuestionAnswersAtom)).toEqual({})
    expect(first.core.continueRecoveredSession(a)).toEqual({ status: 'awaiting_user', sessionId: a, waitingFor: 'waiting_user' })

    first.core.resumeWithAnswers(a)
    for (let attempt = 0; attempt < 100 && aStore.getter(runAtom)?.status !== 'done'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(aStore.getter(itemsAtom).some((entry) => entry.item.role === 'tool' && entry.item.tool_call_id === 'ask-call')).toBe(true)
    expect(bStore.getter(itemsAtom)).toEqual([])
    expect(cStore.getter(itemsAtom)).toEqual([])

    aStore.setter(runAtom, { runId: 'confirm', status: 'waiting_confirmation', pendingToolConfirmation: { callId: 'deny-call', toolName: 'missing-tool', args: {} } })
    aStore.setter(itemsAtom, [...aStore.getter(itemsAtom), { id: 'confirm-call', createdAt: 3, item: { role: 'assistant', content: null, tool_calls: [{ id: 'deny-call', type: 'function', function: { name: 'missing-tool', arguments: '{}' } }] } }])
    first.core.confirmTool(false, false, a)
    for (let attempt = 0; attempt < 100 && aStore.getter(runAtom)?.status !== 'done'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(aStore.getter(itemsAtom).some((entry) => entry.item.role === 'tool' && entry.item.tool_call_id === 'deny-call')).toBe(true)

    aStore.setter(runAtom, { runId: 'live', status: 'running' })
    first.core.stopRun({ sessionId: a })
    expect(aStore.getter(runAtom)?.status).toBe('stopped')
    expect(bStore.getter(runAtom)).toBeUndefined()
    expect(cStore.getter(runAtom)).toBeUndefined()

    aStore.setter(runAtom, { runId: 'interrupted', status: 'interrupted' })
    first.core.continueInterruptedRun(a)
    for (let attempt = 0; attempt < 100 && aStore.getter(runAtom)?.status !== 'done'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(aStore.getter(runAtom)?.status).toBe('done')

    expect(requestCount).toBe(3)
  })

  it('aborts only A real pending request while B is selected and client C keeps running', async () => {
    const pending: Array<{ url: string; signal?: AbortSignal; resolve: () => void }> = []
    const fetchImpl: typeof fetch = (input, init) => new Promise<Response>((resolve) => {
      pending.push({
        url: String(input), signal: init?.signal ?? undefined,
        resolve: () => resolve(new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'settled' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } })),
      })
    })
    const first = await createBrowserAgent({ namespace: `abort-one-${crypto.randomUUID()}`, fetch: fetchImpl })
    const second = await createBrowserAgent({ namespace: `abort-two-${crypto.randomUUID()}`, fetch: fetchImpl })
    clients.push(first, second)
    const connectionA = await first.saveConnection({ label: 'a', baseUrl: 'https://abort-a.example/v1', models: ['m'], apiKey: 'a' })
    const connectionC = await second.saveConnection({ label: 'c', baseUrl: 'https://abort-c.example/v1', models: ['m'], apiKey: 'c' })
    const agentA = await first.saveAgent({ name: 'A', instructions: 'A', connectionId: connectionA.id, model: 'm', toolNames: [], skillNames: [] })
    const agentB = await first.saveAgent({ name: 'B', instructions: 'B', connectionId: connectionA.id, model: 'm', toolNames: [], skillNames: [] })
    const agentC = await second.saveAgent({ name: 'C', instructions: 'C', connectionId: connectionC.id, model: 'm', toolNames: [], skillNames: [] })
    const a = await first.createSession(agentA.id)
    const b = await first.createSession(agentB.id)
    const c = await second.createSession(agentC.id)
    first.core.selectSession(b)

    await Promise.all([
      first.core.sendMessage('pending A', { sessionId: a }),
      second.core.sendMessage('pending C', { sessionId: c }),
    ])
    for (let attempt = 0; attempt < 100 && pending.length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    const requestA = pending.find((request) => request.url.includes('abort-a.example'))
    const requestC = pending.find((request) => request.url.includes('abort-c.example'))
    expect(requestA?.signal?.aborted).toBe(false)
    expect(requestC?.signal?.aborted).toBe(false)

    first.core.stopRun({ sessionId: a })
    expect(requestA?.signal?.aborted).toBe(true)
    expect(requestC?.signal?.aborted).toBe(false)
    expect(second.core.getSessionStore(c).store.getter(runAtom)?.status).toBe('running')
    requestA?.resolve()
    requestC?.resolve()
    for (let attempt = 0; attempt < 100 && second.core.getSessionStore(c).store.getter(runAtom)?.status !== 'done'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(first.core.getSessionStore(a).store.getter(runAtom)?.status).toBe('stopped')
    expect(second.core.getSessionStore(c).store.getter(runAtom)?.status).toBe('done')
  })
})
