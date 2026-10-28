import { afterEach, expect, it, vi } from 'vitest'
import { disposeRemovedOrigins } from '../src/script-registration'
import type { NetworkMethod } from '../src/protocol'

type Gateway = { call(sessionId: string, targetId: string, documentId: string, requestId: string, method: NetworkMethod, input: unknown): Promise<unknown>; dispose(): void }
const key = '__einfachBrowserAgentNetworkGateway__'
const lifecycleKey = '__einfachBrowserAgentNetworkLifecycle__'
const originalFetch = window.fetch

afterEach(() => {
  gateway()?.dispose()
  delete (globalThis as Record<string, unknown>)[key]
  delete (globalThis as Record<string, unknown>)[lifecycleKey]
  window.fetch = originalFetch
  vi.unstubAllGlobals()
})

it('replaces an older MAIN entry once while same-version reinjection preserves the document buffer', async () => {
  const oldDispose = vi.fn()
  ;(globalThis as Record<string, unknown>)[key] = { dispose: oldDispose }
  ;(globalThis as Record<string, unknown>)[lifecycleKey] = { version: 1, resume: vi.fn(), dispose: oldDispose }
  window.fetch = vi.fn(async () => new Response('kept', { headers: { 'content-type': 'text/plain' } }))
  vi.resetModules(); await import('../src/network-main')
  expect(oldDispose).toHaveBeenCalledTimes(1)
  await window.fetch('/before-reinject'); await settle()
  const first = gateway()!
  vi.resetModules(); await import('../src/network-main')
  expect(gateway()).toBe(first)
  const listed = await first.call('session', 'main-frame', 'doc', 'list', 'listRequests', {}) as { capture: { scope: string; recordingStartedAt: number }; requests: Array<{ url: string }> }
  expect(listed.capture.scope).toBe('document')
  expect(listed.requests.map((request) => request.url).join()).toContain('/before-reinject')
})

it('wires the real MAIN entry to the 120 recorder across early fetch, bfcache, refresh, and permission removal', async () => {
  window.fetch = vi.fn(async () => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }))
  vi.resetModules()
  await import('../src/network-main')
  await window.fetch('/before-dialogue'); await settle()
  const first = gateway()!
  const capture = await first.call('session', 'main-frame', 'doc-1', 'start', 'startCapture', {}) as { captureId: string }
  expect(await listed(first, capture.captureId)).toContain('/before-dialogue')

  dispatchPageTransition('pagehide', true)
  expect(gateway()).toBeUndefined()
  dispatchPageTransition('pageshow', true)
  const restored = gateway()!
  await window.fetch('/after-bfcache'); await settle()
  await expect(restored.call('session', 'main-frame', 'doc-1', 'old-bfcache', 'listRequests', { captureId: capture.captureId })).rejects.toThrow('CAPTURE_NOT_FOUND')
  const restoredCapture = await restored.call('session', 'main-frame', 'doc-1', 'restored', 'startCapture', {}) as { captureId: string }
  expect(await listed(restored, restoredCapture.captureId)).toContain('/after-bfcache')

  dispatchPageTransition('pagehide', false)
  expect(gateway()).toBeUndefined()
  vi.resetModules(); await import('../src/network-main')
  await expect(gateway()!.call('session', 'main-frame', 'doc-2', 'old', 'listRequests', { captureId: capture.captureId })).rejects.toThrow('CAPTURE_NOT_FOUND')

  const executeScript = vi.fn(async (details) => { await details.func() })
  vi.stubGlobal('chrome', { tabs: { query: vi.fn().mockResolvedValue([{ id: 3, url: 'https://app.example.com/' }]) }, scripting: { executeScript } })
  await disposeRemovedOrigins(['https://*.example.com/*'])
  expect(gateway()).toBeUndefined()
  dispatchPageTransition('pageshow', true)
  expect(gateway()).toBeUndefined()

  vi.resetModules(); await import('../src/network-main')
  expect(gateway()).toBeDefined()
})

function gateway(): Gateway | undefined { return (globalThis as unknown as Record<string, Gateway | undefined>)[key] }
async function listed(entry: Gateway, captureId: string): Promise<string> {
  const value = await entry.call('session', 'main-frame', 'doc-1', crypto.randomUUID(), 'listRequests', { captureId }) as { requests: Array<{ url: string }> }
  return value.requests.map((request) => request.url).join('\n')
}
async function settle(): Promise<void> { await Promise.resolve(); await Promise.resolve() }
function dispatchPageTransition(type: 'pagehide' | 'pageshow', persisted: boolean): void {
  const event = new Event(type)
  Object.defineProperty(event, 'persisted', { value: persisted })
  dispatchEvent(event)
}

it('replaces session capture state when a same-tab rebind uses a new logical document', async () => {
  window.fetch = vi.fn(async () => new Response('ok'))
  vi.resetModules(); await import('../src/network-main')
  await window.fetch('/before-rebind'); await settle()
  const entry = gateway()!
  const old = await entry.call('session', 'main-frame', 'old-doc', 'old-start', 'startCapture', {}) as { captureId: string }
  const fresh = await entry.call('session', 'main-frame', 'new-doc', 'new-list', 'listRequests', {}) as { capture: { documentId: string }; requests: Array<{ url: string }> }
  expect(fresh.capture.documentId).toBe('new-doc')
  expect(fresh.requests.map((item) => item.url).join()).toContain('/before-rebind')
  await expect(entry.call('session', 'main-frame', 'new-doc', 'old-cursor', 'listRequests', { captureId: old.captureId })).rejects.toThrow('CAPTURE_NOT_FOUND')
})
