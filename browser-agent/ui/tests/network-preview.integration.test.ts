import 'fake-indexeddb/auto'
import { runAtom } from '@einfach-agent/core'
import type { ToolContext } from '@einfach-agent/core/tools'
import { createBrowserAgent } from '@einfach-agent/browser-agent'
import { registerApiTools } from '@einfach-agent/tools-browser-api'
import { registerNetworkTools } from '@einfach-agent/tools-browser-network'
import { registerPageTools } from '@einfach-agent/tools-browser-page'
import { afterEach, expect, it } from 'vitest'
import { createFixtureBusiness, loadCities } from './fixture-business.testFixtures'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()?.() })

it('reads pre-conversation fetch, captures fetch/XHR, isolates frames, and stops cleanly', async () => {
  const container = document.createElement('div'); document.body.append(container)
  const business = await createFixtureBusiness(container, installControlledNetwork)
  cleanup.push(() => business.dispose())
  const modelRequests: Array<{ url: string; authorization: string }> = []
  const modelCredential = 'fixture-model-credential'
  const modelResponseMarker = 'fixture-model-response-outside-business-frame'
  const client = await createBrowserAgent({
    namespace: `network-preview-${crypto.randomUUID()}`,
    fetch: async (input, init) => {
      modelRequests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') ?? '' })
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: modelResponseMarker }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
    registerTools(registry) {
      registerPageTools(registry, business.pageHost)
      registerApiTools(registry, business.apiHost)
      registerNetworkTools(registry, business.networkHost)
    },
  })
  cleanup.push(() => client.dispose())
  const connection = await client.saveConnection({ label: '隔离模型', baseUrl: 'https://model.fixture.invalid/v1', models: ['fixture-model'], apiKey: modelCredential })
  const agent = await client.saveAgent({ name: '隔离验证', instructions: 'Return the fixed fixture response.', connectionId: connection.id, model: 'fixture-model', toolNames: [], skillNames: [] })
  const modelSessionId = await client.createSession(agent.id)
  await business.initialization
  const ctx = context('preview-session')
  const capture = await run<{ captureId: string }>(client, 'start_network_capture', { includeBuffered: true }, ctx)
  const buffered = await run<{ requests: Array<{ requestId: string; url: string; resourceType: string }> }>(client, 'list_network_requests', { captureId: capture.captureId }, ctx)
  expect(buffered.requests).toHaveLength(1)
  expect(buffered.requests[0]).toMatchObject({ resourceType: 'fetch', url: expect.stringContaining('/fixture-api/cities?country=CN') })
  await expect(run(client, 'get_network_response', { captureId: capture.captureId, requestId: buffered.requests[0].requestId }, ctx)).resolves.toMatchObject({ status: 200, body: expect.stringContaining('上海') })

  const wait = run(client, 'wait_for_network_request', { captureId: capture.captureId, urlIncludes: 'country=GB', state: 'finished' }, ctx)
  await loadCities(business.iframe.contentWindow!, business.iframe.contentDocument!, 'GB')
  await expect(wait).resolves.toMatchObject({ method: 'GET', status: 200 })
  await xhr(business.iframe.contentWindow!, new URL('/fixture-api/cities?country=GB&transport=xhr', location.href).href)
  await client.core.sendMessage('verify transport isolation', { sessionId: modelSessionId })
  await waitForRun(client, modelSessionId)
  expect(modelRequests).toEqual([{ url: 'https://model.fixture.invalid/v1/chat/completions', authorization: `Bearer ${modelCredential}` }])
  const active = await run<{ requests: Array<{ requestId: string; resourceType: string; url: string }> }>(client, 'list_network_requests', { captureId: capture.captureId }, ctx)
  expect(active.requests.map((request) => request.resourceType)).toEqual(expect.arrayContaining(['fetch', 'xhr']))
  const capturedDetails = await Promise.all(active.requests.flatMap((request) => [
    run(client, 'get_network_request', { captureId: capture.captureId, requestId: request.requestId }, ctx),
    run(client, 'get_network_response', { captureId: capture.captureId, requestId: request.requestId }, ctx),
  ]))
  const capturedJson = JSON.stringify({ active, capturedDetails })
  expect(capturedJson).not.toContain('model.fixture.invalid')
  expect(capturedJson).not.toContain(modelCredential)
  expect(capturedJson).not.toContain(modelResponseMarker)
  await run(client, 'stop_network_capture', { captureId: capture.captureId }, ctx)
  await loadCities(business.iframe.contentWindow!, business.iframe.contentDocument!, 'CN')
  const stopped = await run<{ requests: unknown[] }>(client, 'list_network_requests', { captureId: capture.captureId }, ctx)
  expect(stopped.requests).toHaveLength(active.requests.length)
})

it('can exclude buffered traffic and never sees another iframe', async () => {
  const first = document.createElement('div'); const second = document.createElement('div'); document.body.append(first, second)
  const business = await createFixtureBusiness(first, installControlledNetwork)
  const other = await createFixtureBusiness(second, installControlledNetwork)
  cleanup.push(() => business.dispose(), () => other.dispose())
  await Promise.all([business.initialization, other.initialization])
  const ctx = context('exclude-buffered')
  const capture = await business.networkHost.startCapture({ includeBuffered: false }, ctx)
  expect((await business.networkHost.listRequests({ captureId: capture.captureId }, ctx)).requests).toHaveLength(0)
  await loadCities(other.iframe.contentWindow!, other.iframe.contentDocument!, 'GB')
  expect((await business.networkHost.listRequests({ captureId: capture.captureId }, ctx)).requests).toHaveLength(0)
})

function installControlledNetwork(window: Window): void {
  window.fetch = async (input) => {
    const country = new URL(String(input), 'http://fixture.local').searchParams.get('country') ?? 'CN'
    const cities = country === 'GB' ? [{ label: '伦敦', value: 'london' }] : [{ label: '上海', value: 'shanghai' }]
    return new Response(JSON.stringify({ country, cities }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  Object.defineProperty(window, 'XMLHttpRequest', { configurable: true, value: ControlledXhr })
}

class ControlledXhr extends EventTarget {
  method = 'GET'; url = ''; status = 200; responseType: XMLHttpRequestResponseType = ''; responseText = JSON.stringify({ cities: [{ label: '伦敦', value: 'london' }] })
  open(method: string, url: string | URL): void { this.method = method; this.url = String(url) }
  setRequestHeader(): void {}
  getResponseHeader(name: string): string | null { return name.toLowerCase() === 'content-type' ? 'application/json' : null }
  getAllResponseHeaders(): string { return 'content-type: application/json\r\n' }
  send(): void { queueMicrotask(() => this.dispatchEvent(new Event('load'))) }
}

function xhr(window: Window, url: string): Promise<void> {
  return new Promise((resolve) => { const request = new window.XMLHttpRequest(); request.open('GET', url); request.addEventListener('load', () => resolve(), { once: true }); request.send() })
}
function context(sessionId: string): ToolContext { return { sessionId, signal: new AbortController().signal } as ToolContext }
async function run<T>(client: Awaited<ReturnType<typeof createBrowserAgent>>, name: string, args: unknown, ctx: ToolContext): Promise<T> {
  const result = await client.core.tools.run(name, args, ctx)
  if (!result.ok) throw new Error(result.error)
  return result.data as T
}
async function waitForRun(client: Awaited<ReturnType<typeof createBrowserAgent>>, sessionId: string): Promise<void> {
  const store = client.core.sessionAtomScope(sessionId)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = store.getter(runAtom)
    if (run?.status === 'done') return
    if (run?.status === 'error' || run?.status === 'stopped' || run?.status === 'interrupted') throw new Error(run.error ?? `Run ${run.status}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for fixture model run')
}
