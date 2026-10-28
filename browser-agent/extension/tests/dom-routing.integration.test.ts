import { beforeEach, expect, it, vi } from 'vitest'
import { ExtensionPageBridge } from '../src/page-bridge'
import type { ExtensionResponse, TargetBinding } from '../src/protocol'

type Listener = (message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => boolean | void
let serviceListener: Listener
let contentListeners: Listener[]
let phase: 'service' | 'content'
let mutateContentResult: ((value: unknown) => unknown) | undefined

beforeEach(async () => {
  vi.resetModules(); contentListeners = []; phase = 'service'; mutateContentResult = undefined
  document.body.innerHTML = '<input aria-label="Title"><div data-trigger tabindex="0">Choose type</div><span data-value>Unselected</span><div data-options hidden><span data-option>Security issue</span></div><div data-scroll>Scrollable</div>'
  const trigger = document.querySelector<HTMLElement>('[data-trigger]')!
  const options = document.querySelector<HTMLElement>('[data-options]')!
  trigger.addEventListener('click', () => setTimeout(() => { options.hidden = false }, 5))
  options.addEventListener('click', (event) => { const option = (event.target as Element).closest('[data-option]'); if (option) document.querySelector('[data-value]')!.textContent = option.textContent })
  Object.defineProperty(HTMLElement.prototype, 'scrollBy', { configurable: true, value: vi.fn() })
  vi.stubGlobal('chrome', chromeHarness())
  await import('../src/service-worker')
  phase = 'content'; await import('../src/content-script')
})

it('routes all DOM methods through bridge, service worker, content script, and the real DOM host', async () => {
  const target = await handshake()
  const bridge = new ExtensionPageBridge(); bridge.bind('session', target)
  const ctx = { sessionId: 'session', signal: new AbortController().signal }
  const initial = await bridge.readDom({ text: 'Choose type' }, ctx)
  const trigger = initial.nodes.find((node) => node.name === 'Choose type')!
  const inputRead = await bridge.readDom({ page: initial.page, selector: 'input' }, ctx)
  const input = inputRead.nodes.find((node) => node.name === 'Title')!
  await expect(bridge.typeDom({ page: initial.page, ref: input.ref, text: 'Report' }, ctx)).resolves.toMatchObject({ dispatched: true })
  await expect(bridge.pressDomKey({ page: initial.page, ref: input.ref, key: 'Enter' }, ctx)).resolves.toMatchObject({ dispatched: true })
  await bridge.clickDom({ page: initial.page, ref: trigger.ref }, ctx)
  const options = await bridge.waitForDom({ page: initial.page, scopeRef: trigger.parentRef, text: 'Security issue', timeoutMs: 200 }, ctx)
  const option = options.nodes.find((node) => node.name === 'Security issue')!
  await bridge.clickDom({ page: initial.page, ref: option.ref }, ctx)
  const scrollRead = await bridge.readDom({ page: initial.page, selector: '[data-scroll]' }, ctx)
  await expect(bridge.scrollDom({ page: initial.page, ref: scrollRead.nodes[0].ref, direction: 'down', amount: 20 }, ctx)).resolves.toMatchObject({ dispatched: true })
  expect((document.querySelector('input') as HTMLInputElement).value).toBe('Report')
  expect(document.querySelector('[data-value]')?.textContent).toBe('Security issue')

  const controller = new AbortController()
  const pending = bridge.waitForDom({ page: initial.page, text: 'never appears', timeoutMs: 1000 }, { sessionId: 'session', signal: controller.signal })
  const cancelledResult = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await new Promise((resolve) => setTimeout(resolve, 0)); controller.abort()
  await cancelledResult

  const cancelled = new AbortController(); cancelled.abort()
  const before = (document.querySelector('input') as HTMLInputElement).value
  await expect(bridge.typeDom({ page: initial.page, ref: input.ref, text: 'x' }, { sessionId: 'session', signal: cancelled.signal })).rejects.toMatchObject({ name: 'AbortError' })
  expect((document.querySelector('input') as HTMLInputElement).value).toBe(before)
  await expect(bridge.readDom({ page: { ...initial.page, documentId: 'navigated-document' } }, context())).rejects.toThrow(/stale/)
  bridge.bind('session', { ...target, documentId: 'old-navigation-binding' })
  await expect(bridge.readDom({ text: 'Choose type' }, context())).rejects.toThrow(/no longer available/i)
  bridge.bind('session', target)

  mutateContentResult = (value) => {
    const response = value as ExtensionResponse
    if (!response.ok || !response.data || typeof response.data !== 'object' || !('nodes' in response.data)) return value
    return { ok: true, data: { ...response.data, nodes: [{ ref: 'dom-x', tag: 'div', name: 'bad', attributes: { role: 7 } }] } }
  }
  await expect(bridge.readDom({ text: 'Choose type' }, context())).rejects.toThrow(/invalid response/i)
  mutateContentResult = (value) => {
    const response = value as ExtensionResponse
    return response.ok && response.data && typeof response.data === 'object' && 'page' in response.data
      ? { ok: true, data: { ...response.data, page: { targetId: 'main-frame', documentId: 'wrong-result-document', revision: 1 } } }
      : value
  }
  await expect(bridge.readDom({ text: 'Choose type' }, context())).rejects.toThrow(/did not match the bound document/i)
  mutateContentResult = undefined
  await assertNavigationInvalidatesReferences()
})

function context() { return { sessionId: 'session', signal: new AbortController().signal } }
async function handshake(): Promise<TargetBinding> {
  const response = await chrome.runtime.sendMessage({ channel: 'einfach-browser-agent-v1', kind: 'handshake', tabId: 7, frameId: 0 }) as ExtensionResponse
  if (!response.ok) throw new Error(response.error)
  return response.data as TargetBinding
}

function chromeHarness(): typeof chrome {
  const invoke = (listener: Listener, message: unknown, sender: chrome.runtime.MessageSender) => new Promise<unknown>((resolve) => {
    const async = listener(message, sender, resolve)
    if (async !== true) queueMicrotask(() => resolve(undefined))
  })
  return {
    runtime: {
      id: 'extension-id', getURL: (path: string) => `chrome-extension://extension-id/${path}`,
      sendMessage: (message: unknown) => invoke(serviceListener, message, { id: 'extension-id', url: 'chrome-extension://extension-id/sidepanel.html' }),
      onMessage: { addListener(listener: Listener) { if (phase === 'service') serviceListener = listener; else contentListeners.push(listener) } },
      onInstalled: { addListener: vi.fn() }, onStartup: { addListener: vi.fn() },
    },
    tabs: {
      query: vi.fn().mockResolvedValue([]), create: vi.fn(), remove: vi.fn(),
      async sendMessage(_tabId: number, message: unknown) {
        for (const listener of contentListeners) {
          const result = await invoke(listener, message, { id: 'extension-id' })
          if (result !== undefined) return mutateContentResult ? mutateContentResult(result) : result
        }
        throw new Error('No content listener handled the request')
      },
    },
    scripting: { executeScript: vi.fn().mockResolvedValue([]), registerContentScripts: vi.fn().mockResolvedValue(undefined), unregisterContentScripts: vi.fn().mockResolvedValue(undefined), getRegisteredContentScripts: vi.fn().mockResolvedValue([]) },
    permissions: { getAll: vi.fn().mockResolvedValue({ origins: [] }), contains: vi.fn(), request: vi.fn(), onAdded: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() } },
    action: { onClicked: { addListener: vi.fn() } }, sidePanel: { setPanelBehavior: vi.fn().mockResolvedValue(undefined), open: vi.fn() }, storage: { local: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined) } },
  } as unknown as typeof chrome
}

async function assertNavigationInvalidatesReferences(): Promise<void> {
  const oldUrl = location.href
  const target = await handshake()
  const bridge = new ExtensionPageBridge(); await bridge.bind('session', target)
  const snapshot = await bridge.readDom({ selector: 'input' }, context())
  const ref = snapshot.nodes[0]!.ref
  const previousValue = (document.querySelector('input') as HTMLInputElement).value
  history.pushState({}, '', '?session-navigation-test=1')
  try {
    await expect(bridge.typeDom({ page: snapshot.page, ref, text: 'wrong page' }, context())).rejects.toThrow(/no longer available|URL has changed/)
    expect((document.querySelector('input') as HTMLInputElement).value).toBe(previousValue)
    expect(bridge.context('session')?.status).toBe('changed')
    const next = await handshake()
    expect(next.documentId).not.toBe(target.documentId)
    expect(next.url).toBe(location.href)
    await bridge.bind('session', next)
    await expect(bridge.typeDom({ page: snapshot.page, ref, text: 'stale' }, context())).rejects.toThrow(/stale/)
    const fresh = await bridge.readDom({ selector: 'input' }, context())
    await bridge.typeDom({ page: fresh.page, ref: fresh.nodes[0]!.ref, text: 'fresh page' }, context())
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('fresh page')
  } finally { history.replaceState({}, '', oldUrl) }
}
