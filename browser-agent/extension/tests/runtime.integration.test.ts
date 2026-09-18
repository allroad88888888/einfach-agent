import 'fake-indexeddb/auto'
import { afterEach, expect, it } from 'vitest'
import { itemsAtom, runAtom, sessionsAtom } from '@einfach-agent/core'
import { createBrowserAgent, type BrowserAgentClient } from '@einfach-agent/browser-agent'
import { createApiToolsHost, registerApiTools } from '@einfach-agent/tools-browser-api'
import { createDomPageHost, registerPageTools } from '@einfach-agent/tools-browser-page'

const clients: BrowserAgentClient[] = []
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.dispose())) })

it('runs mock model → query_options → read/fill/validate through the real core dispatcher', async () => {
  document.body.innerHTML = `<form><label>Country<select name="country"><option value="CN">China</option></select></label><label>Name<input name="name" required></label><label>City<select name="city" required><option value="">Choose</option><option value="shanghai">Shanghai</option></select></label><label>Unsupported<input name="file" type="file"></label></form>`
  const pageHost = createDomPageHost({ document, targetId: 'tab-1', documentId: 'document-1' })
  const allowed = new Set<string>()
  const apiHost = createApiToolsHost([{ id: 'cities', async query(input) { expect(input.parameters).toEqual({ country: 'CN' }); return { options: [{ label: 'Shanghai', value: 'shanghai' }] } } }], { isSourceAllowed: (source, session) => source === 'cities' && allowed.has(session) })
  const requests: Array<{ model: string; tools: string[] }> = []
  const client = await createBrowserAgent({ namespace: `extension-test-${crypto.randomUUID()}`, fetch: modelFetch(requests), registerTools(registry) { registerPageTools(registry, pageHost); registerApiTools(registry, apiHost) } })
  clients.push(client)
  const connection = await client.saveConnection({ label: 'Fixture', baseUrl: 'https://fixture.invalid/v1', models: ['form-model', 'readonly-model', 'denied-model'], apiKey: 'fixture-key' })
  const profiles = await Promise.all([
    client.saveAgent({ name: 'Form', instructions: 'Complete the form.', connectionId: connection.id, model: 'form-model', toolNames: ['query_options', 'read_form', 'fill_fields', 'validate_form'], skillNames: [] }),
    client.saveAgent({ name: 'Read only', instructions: 'Read only.', connectionId: connection.id, model: 'readonly-model', toolNames: ['read_form'], skillNames: [] }),
    client.saveAgent({ name: 'Denied', instructions: 'No page tools.', connectionId: connection.id, model: 'denied-model', toolNames: [], skillNames: [] }),
  ])
  const sessions = await Promise.all(profiles.map((profile) => client.createSession(profile.id)))
  allowed.add(sessions[0])
  expect(client.core.rootStore.getter(sessionsAtom)[sessions[1]].settings.model).toBe('readonly-model')
  expect(client.core.rootStore.getter(sessionsAtom)[sessions[2]].capabilityPolicy).toMatchObject({ allowedTools: [] })
  await client.core.sendMessage('Fill this form.', { sessionId: sessions[0] })
  await waitFor(() => requests.length >= 9)
  expect((document.querySelector('[name=name]') as HTMLInputElement).value).toBe('Ada')
  expect((document.querySelector('[name=city]') as HTMLSelectElement).value).toBe('shanghai')
  expect(requests[0]).toMatchObject({ model: 'form-model' })
  expect(requests.flatMap((request) => request.tools)).toEqual(expect.arrayContaining(['query_options', 'fill_fields', 'validate_form']))
})

it('settles forbidden tools and API authorization/source failures through the real dispatcher', async () => {
  document.body.innerHTML = '<form><label>Name<input name="name"></label></form>'
  const pageHost = createDomPageHost({ document, targetId: 'tab-errors', documentId: 'document-errors' })
  const allowedSessions = new Set<string>()
  const sourceCalls: string[] = []
  const apiHost = createApiToolsHost([
    { id: 'cities', async query() { sourceCalls.push('cities'); return { options: [{ label: 'Never', value: 'never' }] } } },
    { id: 'broken', async query() { sourceCalls.push('broken'); throw new Error('fixture secret must not escape') } },
  ], { isSourceAllowed: (_source, session) => allowedSessions.has(session) })
  const client = await createBrowserAgent({ namespace: `extension-errors-${crypto.randomUUID()}`, fetch: failureModelFetch(), registerTools(registry) { registerPageTools(registry, pageHost); registerApiTools(registry, apiHost) } })
  clients.push(client)
  const connection = await client.saveConnection({ label: 'Errors', baseUrl: 'https://fixture.invalid/v1', models: ['readonly', 'denied-source', 'broken-source'], apiKey: 'fixture-key' })
  const agents = await Promise.all([
    client.saveAgent({ name: 'Readonly', instructions: 'Attempt forbidden write.', connectionId: connection.id, model: 'readonly', toolNames: ['read_form'], skillNames: [] }),
    client.saveAgent({ name: 'Denied source', instructions: 'Query denied source.', connectionId: connection.id, model: 'denied-source', toolNames: ['query_options'], skillNames: [] }),
    client.saveAgent({ name: 'Broken source', instructions: 'Query failing source.', connectionId: connection.id, model: 'broken-source', toolNames: ['query_options'], skillNames: [] }),
  ])
  const sessions = await Promise.all(agents.map((agent) => client.createSession(agent.id)))
  allowedSessions.add(sessions[2])
  await Promise.all(sessions.map((sessionId) => client.core.sendMessage('Exercise the configured failure.', { sessionId })))
  const statuses = await Promise.all(sessions.map((sessionId) => waitForRun(client, sessionId)))
  const results = sessions.map((sessionId) => client.core.sessionAtomScope(sessionId).getter(itemsAtom)
    .filter((entry) => entry.item.role === 'tool').map((entry) => entry.item.content).join('\n'))
  expect(results[0]).toMatch(/denied|not allowed|capability/i)
  expect(results[1]).toMatch(/denied|not allowed|source/i)
  expect(results[2]).toMatch(/failed|unavailable|query/i)
  expect(results.join('\n')).not.toContain('fixture secret')
  expect(sourceCalls).toEqual(['broken'])
  expect((document.querySelector('[name=name]') as HTMLInputElement).value).toBe('')
  expect(statuses).toEqual(['done', 'done', 'done'])
})

function modelFetch(requests: Array<{ model: string; tools: string[] }>): typeof fetch {
  let turn = 0
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; name?: string; tool_call_id?: string; content?: string }> }
    requests.push({ model: body.model, tools: (body.tools ?? []).map((tool) => tool.function.name) })
    const snapshot = body.messages.flatMap((message) => {
      if (message.role !== 'tool') return []
      try { const value = JSON.parse(message.content ?? '{}') as { page?: unknown; fields?: Array<{ id: string; label: string }> }; return value.page && value.fields ? [value] : [] } catch { return [] }
    }).at(-1)
    const names = ['query_options', 'query_options', 'read_form', 'read_form', 'fill_fields', 'fill_fields', 'validate_form', 'validate_form']
    const name = names[turn]
    const input = name === 'query_options' ? { sourceId: 'cities', parameters: { country: 'CN' } }
      : name === 'fill_fields' ? { page: snapshot?.page, values: [{ id: snapshot?.fields?.find((field) => field.label === 'Name')?.id, value: 'Ada' }, { id: snapshot?.fields?.find((field) => field.label.startsWith('City'))?.id, value: 'shanghai' }] }
        : name === 'validate_form' ? { page: snapshot?.page } : {}
    const message = name ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${turn}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } : { role: 'assistant', content: 'Completed.' }
    turn += 1
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: name ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  }
}

function failureModelFetch(): typeof fetch {
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ role: string }> }
    const toolResults = body.messages.filter((message) => message.role === 'tool').length
    let name: string | undefined
    let input: object = {}
    if (body.model === 'readonly' && toolResults === 0) { name = 'fill_fields'; input = { page: { targetId: 'tab-errors', documentId: 'document-errors', revision: 1 }, values: [{ id: 'field-1', value: 'changed' }] } }
    if (body.model === 'denied-source' && toolResults < 2) { name = 'query_options'; input = { sourceId: 'cities' } }
    if (body.model === 'broken-source' && toolResults < 2) { name = 'query_options'; input = { sourceId: 'broken' } }
    const message = name ? { role: 'assistant', content: null, tool_calls: [{ id: `${body.model}-${toolResults}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } : { role: 'assistant', content: 'Failure observed safely.' }
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: name ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  }
}

async function waitForRun(client: BrowserAgentClient, sessionId: string): Promise<string> {
  const store = client.core.sessionAtomScope(sessionId)
  await waitFor(() => ['done', 'error', 'stopped', 'interrupted'].includes(store.getter(runAtom)?.status ?? ''))
  return store.getter(runAtom)?.status ?? 'missing'
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000
  while (!assertion()) { if (Date.now() > deadline) throw new Error('Timed out waiting for agent run'); await new Promise((resolve) => setTimeout(resolve, 10)) }
}
