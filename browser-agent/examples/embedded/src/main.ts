import { createBrowserAgent, type BrowserAgentClient } from '@einfach-agent/browser-agent'
import { runAtom } from '@einfach-agent/core'
import { createApiToolsHost, registerApiTools } from '@einfach-agent/tools-browser-api'
import { createDomToolsHost, registerDomTools, type DomNode } from '@einfach-agent/tools-browser-dom'
import { createDomPageHost, registerPageTools, type ControlledFieldAdapter, type FieldValue } from '@einfach-agent/tools-browser-page'
import { createWindowNetworkHost, installWindowNetworkRecorder, registerNetworkTools } from '@einfach-agent/tools-browser-network'

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
  frame.srcdoc = `<form><label>${label}<input name="person" required></label><label>Country<select name="country"><option value="${country}">${country}</option></select></label><label>City<select name="city"><option value="">Choose</option><option value="${cityValue}">${country} city</option></select></label><label>Controlled note<div data-controlled role="textbox"></div></label><div data-ticket-select><div data-ticket-trigger tabindex="0">Ticket type</div><span data-ticket-value>Unselected</span><div data-ticket-options hidden><span data-ticket-option>General question</span><span data-ticket-option>Security vulnerability</span></div></div></form>`
  while (!frame.contentDocument?.querySelector('form')) await new Promise((resolve) => setTimeout(resolve, 10))
  const recorder = installWindowNetworkRecorder({ window: frame.contentWindow! })
  const networkHost = createWindowNetworkHost({ window: frame.contentWindow!, targetId: namespace, documentId: `${namespace}-document` })
  const pageHost = createDomPageHost({ document: frame.contentDocument!, targetId: namespace, documentId: `${namespace}-document`, controlledAdapters: [controlledAdapter()] })
  const domHost = createDomToolsHost({ document: frame.contentDocument!, targetId: namespace, documentId: `${namespace}-document` })
  wireTicketSelect(frame.contentDocument!)
  const apiHost = createApiToolsHost([{ id: 'cities', async query() { return { options: [{ label: `${country} city`, value: cityValue }] } } }], { isSourceAllowed: (_source, sessionId) => Boolean(sessionId) })
  const client = await createBrowserAgent({ namespace, fetch: createMockModelFetch(), registerTools(registry) { registerPageTools(registry, pageHost); registerDomTools(registry, domHost); registerApiTools(registry, apiHost); registerNetworkTools(registry, networkHost) } })
  window.addEventListener('pagehide', () => { networkHost.dispose(); recorder.dispose(); void client.dispose() }, { once: true })
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
    const agent = await client.saveAgent({ id: oldAgent?.id, name, instructions: 'Use DOM tools to select Security vulnerability in the custom ticket type, then report completion.', connectionId: connection.id, model, toolNames: ['read_dom', 'click_dom', 'wait_for_dom'], skillNames: [] })
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
    const messages = body.messages ?? []
    const turn = messages.filter((message) => message.role === 'tool').length
    const names = ['request_tool_schema', 'request_tool_schema', 'request_tool_schema', 'read_dom', 'click_dom', 'wait_for_dom', 'click_dom', 'read_dom']
    const name = names[turn]
    const args = name === 'request_tool_schema' ? { toolName: ['read_dom', 'click_dom', 'wait_for_dom'][turn] } : domArguments(messages, name, turn)
    const message = name ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${turn}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'Form completed and validated.' }
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: name ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  }
}

function domArguments(messages: Array<{ role: string; content?: string }>, name: string | undefined, turn: number): object {
  const snapshots = messages.flatMap((message) => {
    if (message.role !== 'tool') return []
    try { const value = JSON.parse(message.content ?? '{}') as { page?: unknown; nodes?: DomNode[] }; return value.page && value.nodes ? [value] : [] } catch { return [] }
  })
  const latest = snapshots.at(-1)
  if (name === 'read_dom') return latest ? { page: latest.page, text: 'Security vulnerability' } : { text: 'Ticket type' }
  if (name === 'wait_for_dom') return { page: latest?.page, scopeRef: latest?.nodes?.find((node) => node.name.includes('Ticket type'))?.parentRef, text: 'Security vulnerability', condition: 'present', timeoutMs: 1000 }
  const wanted = turn < 6 ? 'Ticket type' : 'Security vulnerability'
  return { page: latest?.page, ref: [...(latest?.nodes ?? [])].reverse().find((node) => node.name === wanted)?.ref }
}

function wireTicketSelect(document: Document): void {
  const trigger = document.querySelector<HTMLElement>('[data-ticket-trigger]')!
  const list = document.querySelector<HTMLElement>('[data-ticket-options]')!
  trigger.addEventListener('click', () => { setTimeout(() => { list.hidden = false; trigger.setAttribute('aria-expanded', 'true') }, 20) })
  list.addEventListener('click', (event) => {
    const option = (event.target as Element).closest('[data-ticket-option]')
    if (!option) return
    document.querySelector<HTMLElement>('[data-ticket-value]')!.textContent = option.textContent
    list.hidden = true; trigger.setAttribute('aria-expanded', 'false')
  })
}
