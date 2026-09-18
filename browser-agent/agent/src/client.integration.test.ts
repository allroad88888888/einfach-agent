import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { createBrowserAgent } from './client'
import { itemsAtom, runAtom, sessionsAtom } from '@einfach-agent/core'

const clients: Array<Awaited<ReturnType<typeof createBrowserAgent>>> = []
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.dispose())) })

function namespace(label: string): string { return `${label}-${crypto.randomUUID()}` }

async function configuredClient(name: string, fetchImpl?: typeof fetch) {
  const client = await createBrowserAgent({ namespace: name, fetch: fetchImpl })
  clients.push(client)
  const connection = await client.saveConnection({ label: 'primary', baseUrl: 'https://one.example/v1', models: ['m1'], apiKey: 'secret-1' })
  const skill = await client.saveSkill({ name: 'form-help', description: 'fills a form', triggers: ['form'], content: 'FROZEN BODY V1', resources: { 'reference.txt': 'RESOURCE V1' } })
  const agent = await client.saveAgent({ name: 'Agent A', instructions: 'ALWAYS ALPHA', connectionId: connection.id, model: 'm1', toolNames: ['skill_search', 'skill_read'], skillNames: [skill.name] })
  return { client, connection, skill, agent }
}

describe('browser agent configuration and persistence', () => {
  it('serializes concurrent writes, hides credentials, freezes nested snapshots, and restores data', async () => {
    const name = namespace('config')
    const { client, connection } = await configuredClient(name)
    expect(client.core.timedToolRegistrations('compact').map((item) => item.name)).toEqual(['compact_context'])
    await Promise.all([
      client.saveSkill({ name: 'one', description: 'one', triggers: [], content: 'one', resources: {} }),
      client.saveSkill({ name: 'two', description: 'two', triggers: [], content: 'two', resources: {} }),
    ])
    const snapshot = client.getSnapshot()
    expect(snapshot.skills.map((item) => item.name)).toEqual(expect.arrayContaining(['one', 'two']))
    expect(snapshot.connections[0]).not.toHaveProperty('apiKey')
    expect(() => (snapshot.connections[0].models as string[]).push('mutated')).toThrow()
    await expect(createBrowserAgent({ namespace: name })).rejects.toThrow('already has an owner')
    await client.dispose()
    clients.splice(clients.indexOf(client), 1)
    const restored = await createBrowserAgent({ namespace: name })
    clients.push(restored)
    expect(restored.getSnapshot().connections[0]).toMatchObject({ id: connection.id, credentialConfigured: true })
    expect(restored.getSnapshot().skills.map((item) => item.name)).toEqual(expect.arrayContaining(['one', 'two']))
  })

  it('keeps endpoint and skill content per session while rotating the logical connection key', async () => {
    const requests: Array<{ url: string; authorization: string; body: string }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') ?? '', body: String(init?.body) })
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const { client, connection, agent } = await configuredClient(namespace('run'), fetchImpl)
    const oldSession = await client.createSession(agent.id)
    await client.saveSkill({ name: 'form-help', description: 'fills a form', triggers: ['form'], content: 'FROZEN BODY V2', resources: { 'reference.txt': 'RESOURCE V2' } })
    await client.saveConnection({ ...connection, baseUrl: 'https://two.example/v1', apiKey: 'secret-2' })
    const newSession = await client.createSession(agent.id)
    await client.core.sendMessage('old', { sessionId: oldSession })
    await client.core.sendMessage('new', { sessionId: newSession })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(requests.map((item) => item.url)).toEqual(['https://one.example/v1/chat/completions', 'https://two.example/v1/chat/completions'])
    expect(requests.map((item) => item.authorization)).toEqual(['Bearer secret-2', 'Bearer secret-2'])
    expect(requests[0].body).toContain('ALWAYS ALPHA')
    expect(requests[0].body).toContain('form-help')
    expect(requests[0].body).not.toContain('FROZEN BODY V1')
    expect(requests[0].body).not.toContain('FROZEN BODY V2')
  })

  it('durably restores a session after immediate dispose and recreate', async () => {
    const name = namespace('durable-session')
    const { client, agent } = await configuredClient(name)
    const sessionId = await client.createSession(agent.id)
    await client.dispose()
    clients.splice(clients.indexOf(client), 1)
    const restored = await createBrowserAgent({ namespace: name })
    clients.push(restored)
    expect(restored.core.sessionIds()).toContain(sessionId)
  })

  it('keeps default dispose as an explicit stop with no recovery action', async () => {
    const name = namespace('default-dispose-stop')
    let signal: AbortSignal | undefined
    const fetchImpl: typeof fetch = async (_input, init) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>(() => undefined)
    }
    const { client, agent } = await configuredClient(name, fetchImpl)
    const sessionId = await client.createSession(agent.id)
    await client.core.sendMessage('stop on close', { sessionId })
    for (let attempt = 0; attempt < 100 && !signal; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))

    await client.dispose({ preserveRecovery: false })
    clients.splice(clients.indexOf(client), 1)
    expect(signal?.aborted).toBe(true)

    const restored = await createBrowserAgent({ namespace: name, fetch: fetchImpl })
    clients.push(restored)
    expect(restored.core.getSessionStore(sessionId).store.getter(runAtom)?.status).toBe('stopped')
    expect(restored.core.getSessionRecoveryStatus(sessionId)).toMatchObject({
      status: 'unavailable',
      reason: 'nonrecoverable',
    })
  })

  it('waits for in-flight configuration mutations before releasing the namespace', async () => {
    const name = namespace('dispose-mutation')
    const { client } = await configuredClient(name)
    let notifications = 0
    client.subscribe(() => { notifications += 1 })
    const first = client.saveSkill({ name: 'queued-one', description: 'one', triggers: [], content: 'one', resources: {} })
    const second = client.saveSkill({ name: 'queued-two', description: 'two', triggers: [], content: 'two', resources: {} })
    const disposing = client.dispose()
    await Promise.all([first, second, disposing])
    const countAtDispose = notifications
    await Promise.resolve()
    expect(notifications).toBe(countAtDispose)
    clients.splice(clients.indexOf(client), 1)
    const restored = await createBrowserAgent({ namespace: name })
    clients.push(restored)
    expect(restored.getSnapshot().skills.map((skill) => skill.name)).toEqual(expect.arrayContaining(['queued-one', 'queued-two']))
  })

  it('preserves an aborted model request for immediate recovery and ignores its late response', async () => {
    const name = namespace('host-close-recovery')
    let firstSignal: AbortSignal | undefined
    let resolveFirst!: (response: Response) => void
    let requestCount = 0
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestCount += 1
      if (requestCount === 1) {
        firstSignal = init?.signal ?? undefined
        return new Promise<Response>((resolve) => { resolveFirst = resolve })
      }
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'recovered' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const { client, agent } = await configuredClient(name, fetchImpl)
    const sessionId = await client.createSession(agent.id)
    await client.core.sendMessage('keep this turn', { sessionId })
    for (let attempt = 0; attempt < 100 && !firstSignal; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))

    const firstDispose = client.dispose({ preserveRecovery: true })
    expect(client.dispose()).toBe(firstDispose)
    await firstDispose
    expect(firstSignal?.aborted).toBe(true)
    clients.splice(clients.indexOf(client), 1)

    const restored = await createBrowserAgent({ namespace: name, fetch: fetchImpl })
    clients.push(restored)
    expect(restored.core.getSessionRecoveryStatus(sessionId)).toMatchObject({
      status: 'recoverable',
      continuation: 'interrupted_run',
    })
    expect(restored.core.continueRecoveredSession(sessionId)).toMatchObject({ status: 'continued' })
    for (let attempt = 0; attempt < 100 && restored.core.getSessionStore(sessionId).store.getter(runAtom)?.status !== 'done'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(restored.core.getSessionStore(sessionId).store.getter(runAtom)?.status).toBe('done')

    resolveFirst(new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'late-old-response' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    const restoredItems = restored.core.getSessionStore(sessionId).store.getter(itemsAtom)
    expect(JSON.stringify(restoredItems)).toContain('recovered')
    expect(JSON.stringify(restoredItems)).not.toContain('late-old-response')
  })

  it('keeps the positive tool allowlist fixed when a tool is registered before first send', async () => {
    const { client, agent } = await configuredClient(namespace('fixed-policy'))
    const sessionId = await client.createSession(agent.id)
    client.core.tools.register({
      name: 'late_tool', runtime: 'internal', execution: { mode: 'parallel', effectKeys: [] },
      skill: { description: 'late', triggers: [], content: 'late' },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: () => ({ ok: true, data: {} }),
    })
    const policy = client.core.rootStore.getter(sessionsAtom)[sessionId]?.capabilityPolicy
    expect(policy).toMatchObject({ state: 'locked', allowedTools: ['skill_read', 'skill_search'] })
    expect(policy && 'allowedTools' in policy ? policy.allowedTools : []).not.toContain('late_tool')
  })

  it('reloads an old session and executes search/read against its frozen skill content', async () => {
    const bodies: string[] = []
    let turn = 0
    const fetchImpl: typeof fetch = async (_input, init) => {
      bodies.push(String(init?.body))
      const messages = [
        { role: 'assistant', content: null, tool_calls: [{ id: 'search', type: 'function', function: { name: 'skill_search', arguments: '{"query":"form"}' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'search2', type: 'function', function: { name: 'skill_search', arguments: '{"query":"form"}' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'read', type: 'function', function: { name: 'skill_read', arguments: '{"name":"form-help"}' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'read2', type: 'function', function: { name: 'skill_read', arguments: '{"name":"form-help"}' } }] },
        { role: 'assistant', content: 'done' },
      ]
      return new Response(JSON.stringify({ choices: [{ message: messages[turn++], finish_reason: turn < 5 ? 'tool_calls' : 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const name = namespace('frozen-tools')
    const { client, agent } = await configuredClient(name, fetchImpl)
    const sessionId = await client.createSession(agent.id)
    await client.saveSkill({ name: 'form-help', description: 'new description', triggers: ['other'], content: 'FROZEN BODY V2', resources: {} })
    await client.saveAgent({ ...agent, instructions: 'NEW INSTRUCTIONS' })
    await client.dispose()
    clients.splice(clients.indexOf(client), 1)
    const restored = await createBrowserAgent({ namespace: name, fetch: fetchImpl })
    clients.push(restored)
    await restored.core.sendMessage('use the skill', { sessionId })
    for (let attempt = 0; attempt < 100 && bodies.length < 5; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(bodies).toHaveLength(5)
    expect(bodies[0]).toContain('ALWAYS ALPHA')
    expect(bodies[0]).not.toContain('NEW INSTRUCTIONS')
    expect(bodies[2]).toContain('form-help')
    expect(bodies[4]).toContain('FROZEN BODY V1')
    expect(bodies[4]).not.toContain('FROZEN BODY V2')
  })
})
