import { runAtom } from '@einfach-agent/core'
import { createBrowserAgent } from '@einfach-agent/browser-agent'
import { createApiToolsHost, registerApiTools } from '@einfach-agent/tools-browser-api'
import { registerPageTools } from '@einfach-agent/tools-browser-page'
import { ExtensionPageBridge } from '../src/page-bridge'
import type { TargetBinding } from '../src/protocol'

declare global { interface Window { runRuntimeHarness(target: TargetBinding): Promise<unknown>; runtimeStage: string } }

window.runRuntimeHarness = async (target) => {
  window.runtimeStage = 'create-client'
  const bridge = new ExtensionPageBridge()
  const requests: Array<{ model: string; tools: string[] }> = []
  const apiHost = createApiToolsHost([{
    id: 'cities',
    async query(input) {
      if (input.parameters?.country !== 'CN') throw new Error('missing dependent country')
      return { options: [{ label: 'Shanghai', value: 'shanghai' }] }
    },
  }], { isSourceAllowed: (sourceId, sessionId) => sourceId === 'cities' && Boolean(bridge.target(sessionId)) })
  const client = await createBrowserAgent({
    namespace: `mv3-runtime-${crypto.randomUUID()}`,
    fetch: createModelFetch(requests),
    registerTools(registry) { registerPageTools(registry, bridge); registerApiTools(registry, apiHost) },
  })
  try {
    window.runtimeStage = 'configure'
    const connection = await client.saveConnection({ label: 'Fixture', baseUrl: 'https://fixture.invalid/v1', models: ['form-model', 'readonly-model', 'denied-model'], apiKey: 'local-fixture-only' })
    const agents = await Promise.all([
      client.saveAgent({ name: 'Form', instructions: 'Use the option source and complete the form.', connectionId: connection.id, model: 'form-model', toolNames: ['query_options', 'read_form', 'fill_fields', 'validate_form'], skillNames: [] }),
      client.saveAgent({ name: 'Reader', instructions: 'Read only.', connectionId: connection.id, model: 'readonly-model', toolNames: ['read_form'], skillNames: [] }),
      client.saveAgent({ name: 'Denied', instructions: 'Answer without tools.', connectionId: connection.id, model: 'denied-model', toolNames: [], skillNames: [] }),
    ])
    const sessionIds = await Promise.all(agents.map((agent) => client.createSession(agent.id)))
    const secondFormSession = await client.createSession(agents[0].id)
    const allSessionIds = [...sessionIds, secondFormSession]
    for (const sessionId of allSessionIds) bridge.bind(sessionId, target)
    window.runtimeStage = 'form-run'
    await client.core.sendMessage('Complete the form.', { sessionId: sessionIds[0] })
    await waitForRun(client, sessionIds[0])
    window.runtimeStage = 'capability-runs'
    await Promise.all([
      client.core.sendMessage('Read.', { sessionId: sessionIds[1] }),
      client.core.sendMessage('Answer.', { sessionId: sessionIds[2] }),
      client.core.sendMessage('Complete it again.', { sessionId: secondFormSession }),
    ])
    await Promise.all([...sessionIds.slice(1), secondFormSession].map((sessionId) => waitForRun(client, sessionId)))
    window.runtimeStage = 'read-and-restore'
    const snapshot = await bridge.readForm({ sessionId: sessionIds[0], signal: new AbortController().signal })
    const restored = new ExtensionPageBridge()
    await restored.restore(allSessionIds)
    window.runtimeStage = 'done'
    return {
      ok: snapshot.fields.some((field) => field.label === 'Name' && field.value === 'Ada')
        && snapshot.fields.some((field) => field.label.startsWith('City') && field.value === 'shanghai'),
      sessionIds: allSessionIds,
      models: agents.map((agent) => agent.model),
      toolSets: Object.fromEntries(requests.map((request) => [request.model, request.tools])),
      queryValueUsed: snapshot.fields.find((field) => field.label.startsWith('City'))?.value,
      restoredBindings: allSessionIds.map((sessionId) => restored.target(sessionId)?.documentId),
      requests: requests.length,
    }
  } finally { await client.dispose() }
}

function createModelFetch(requests: Array<{ model: string; tools: string[] }>): typeof fetch {
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content?: string }> }
    requests.push({ model: body.model, tools: (body.tools ?? []).map((tool) => tool.function.name) })
    if (body.model !== 'form-model') return response({ role: 'assistant', content: `${body.model} complete.` }, false)
    const turn = body.messages.filter((message) => message.role === 'tool').length
    const names = ['query_options', 'query_options', 'read_form', 'read_form', 'fill_fields', 'fill_fields', 'validate_form', 'validate_form']
    const name = names[turn]
    if (!name) return response({ role: 'assistant', content: 'Form completed.' }, false)
    const snapshot = findForm(body.messages)
    const option = findOption(body.messages)
    const args = name === 'query_options' ? { sourceId: 'cities', parameters: { country: 'CN' } }
      : name === 'fill_fields' ? { page: snapshot?.page, values: [{ id: snapshot?.fields.find((field) => field.label === 'Name')?.id, value: 'Ada' }, { id: snapshot?.fields.find((field) => field.label.startsWith('City'))?.id, value: option }] }
        : name === 'validate_form' ? { page: snapshot?.page } : {}
    return response({ role: 'assistant', content: null, tool_calls: [{ id: `call-${turn}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, true)
  }
}

function response(message: object, tools: boolean): Response {
  return new Response(JSON.stringify({ choices: [{ message, finish_reason: tools ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
}
function findForm(messages: Array<{ role: string; content?: string }>) {
  return messages.flatMap((message) => { try { const value = JSON.parse(message.content ?? '{}'); return value.page && value.fields ? [value] : [] } catch { return [] } }).at(-1) as { page: unknown; fields: Array<{ id: string; label: string }> } | undefined
}
function findOption(messages: Array<{ role: string; content?: string }>): string | undefined {
  return messages.flatMap((message) => { try { return JSON.parse(message.content ?? '{}').options ?? [] } catch { return [] } }).at(-1)?.value
}
async function waitForRun(client: Awaited<ReturnType<typeof createBrowserAgent>>, sessionId: string): Promise<void> {
  const store = client.core.sessionAtomScope(sessionId)
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const run = store.getter(runAtom)
    if (run?.status === 'done') return
    if (run?.status === 'error' || run?.status === 'stopped' || run?.status === 'interrupted') throw new Error(run.error ?? run.status)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('runtime harness timed out')
}
