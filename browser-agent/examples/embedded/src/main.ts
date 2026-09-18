import { createBrowserAgent, type BrowserAgentClient } from '@einfach-agent/browser-agent'
import { runAtom } from '@einfach-agent/core'
import { createApiToolsHost, registerApiTools } from '@einfach-agent/tools-browser-api'
import { createDomPageHost, registerPageTools, type ControlledFieldAdapter, type FieldValue } from '@einfach-agent/tools-browser-page'

const root = document.querySelector<HTMLElement>('#agents')!
await Promise.all([
  mountAgent('sales-agent', 'Sales assistant', 'sales-model', 'Customer', 'CN'),
  mountAgent('travel-agent', 'Travel assistant', 'travel-model', 'Traveller', 'GB'),
])

async function mountAgent(namespace: string, name: string, model: string, label: string, country: string): Promise<void> {
  const cityValue = `${country.toLowerCase()}-city`
  const card = document.createElement('section')
  card.className = 'agent'
  card.innerHTML = `<h2>${name}</h2><p>Namespace: <code>${namespace}</code></p><button disabled>Configure and run</button><p class="status">Ready</p><iframe title="${name} form"></iframe>`
  root.append(card)
  const frame = card.querySelector('iframe')!
  frame.srcdoc = `<form><label>${label}<input name="person" required></label><label>Country<select name="country"><option value="${country}">${country}</option></select></label><label>City<select name="city"><option value="">Choose</option><option value="${cityValue}">${country} city</option></select></label><label>Controlled note<div data-controlled role="textbox"></div></label></form>`
  while (!frame.contentDocument?.querySelector('form')) await new Promise((resolve) => setTimeout(resolve, 10))
  const pageHost = createDomPageHost({ document: frame.contentDocument!, targetId: namespace, documentId: `${namespace}-document`, controlledAdapters: [controlledAdapter()] })
  const apiHost = createApiToolsHost([{ id: 'cities', async query() { return { options: [{ label: `${country} city`, value: cityValue }] } } }], { isSourceAllowed: (_source, sessionId) => Boolean(sessionId) })
  const client = await createBrowserAgent({ namespace, fetch: createMockModelFetch(), registerTools(registry) { registerPageTools(registry, pageHost); registerApiTools(registry, apiHost) } })
  const status = card.querySelector<HTMLElement>('.status')!
  const button = card.querySelector('button')!
  button.addEventListener('click', () => void run(client, name, model, status))
  button.disabled = false
}

function controlledAdapter(): ControlledFieldAdapter {
  return {
    kind: 'fixture-controlled',
    matches: (element) => element.matches('[data-controlled]'),
    read: (element) => ({ label: 'Controlled note', value: element.textContent ?? '', required: true, readOnly: false, supported: true }),
    async write(element, value: FieldValue, ctx) {
      await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 25); ctx.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('cancelled', 'AbortError')) }, { once: true }) })
      element.textContent = String(value)
    },
    validate: (element) => element.textContent ? undefined : 'controlled note is required',
  }
}

async function run(client: BrowserAgentClient, name: string, model: string, status: HTMLElement): Promise<void> {
  try {
    status.textContent = 'Configuring…'
    const snapshot = client.getSnapshot()
    const oldConnection = snapshot.connections.find((item) => item.label === `${name} local`)
    const connection = await client.saveConnection({ id: oldConnection?.id, label: `${name} local`, baseUrl: 'https://fixture.invalid/v1', models: [model], apiKey: 'fixture-only' })
    const oldAgent = client.getSnapshot().agents.find((item) => item.name === name)
    const agent = await client.saveAgent({ id: oldAgent?.id, name, instructions: 'Query cities, read the form, fill it, validate it, then report completion.', connectionId: connection.id, model, toolNames: ['query_options', 'read_form', 'fill_fields', 'validate_form'], skillNames: [] })
    const sessionId = await client.createSession(agent.id)
    status.textContent = 'Running real core and tool dispatch…'
    await client.core.sendMessage('Complete this form.', { sessionId })
    await waitForRun(client, sessionId)
    status.textContent = `Completed in isolated session ${sessionId.slice(0, 8)}.`
  } catch (error) { status.textContent = error instanceof Error ? error.message : 'Run failed' }
}

async function waitForRun(client: BrowserAgentClient, sessionId: string): Promise<void> {
  const store = client.core.sessionAtomScope(sessionId)
  while (true) {
    const run = store.getter(runAtom)
    if (run?.status === 'done') return
    if (run?.status === 'error' || run?.status === 'stopped' || run?.status === 'interrupted') throw new Error(run.error ?? `Run ${run.status}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function createMockModelFetch(): typeof fetch {
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role: string; content?: string }> }
    const turn = (body.messages ?? []).filter((message) => message.role === 'tool').length
    const names = ['query_options', 'query_options', 'read_form', 'read_form', 'fill_fields', 'fill_fields', 'validate_form', 'validate_form']
    const name = names[turn]
    const args = name === 'query_options' ? { sourceId: 'cities' } : name === 'fill_fields' ? pageArguments(body.messages ?? []) : name === 'validate_form' ? pageArguments(body.messages ?? [], true) : {}
    const message = name ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${turn}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'Form completed and validated.' }
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: name ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  }
}

function pageArguments(messages: Array<{ role: string; content?: string }>, validate = false): object {
  const snapshot = messages.flatMap((message) => {
    if (message.role !== 'tool') return []
    try { const value = JSON.parse(message.content ?? '{}') as { page?: unknown; fields?: Array<{ id: string; label: string }> }; return value.page && value.fields ? [value] : [] } catch { return [] }
  }).at(-1) ?? {}
  if (validate) return { page: snapshot.page }
  const options = messages.flatMap((message) => {
    if (message.role !== 'tool') return []
    try { const value = JSON.parse(message.content ?? '{}') as { options?: Array<{ value: string }> }; return value.options ?? [] } catch { return [] }
  })
  const person = snapshot.fields?.find((field) => field.label === 'Customer' || field.label === 'Traveller')
  const city = snapshot.fields?.find((field) => field.label.startsWith('City'))
  const controlled = snapshot.fields?.find((field) => field.label === 'Controlled note')
  return { page: snapshot.page, values: [{ id: person?.id, value: 'Ada' }, { id: city?.id, value: options.at(-1)?.value }, { id: controlled?.id, value: 'adapter-value' }] }
}
