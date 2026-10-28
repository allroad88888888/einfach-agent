import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PageBindings } from '../src/page-bindings'
import type { TargetBinding } from '../src/protocol'

const target: TargetBinding = { tabId: 7, frameId: 0, targetId: 'main-frame', documentId: 'doc-a', revision: 1, title: '报销申请', url: 'https://example.test/form?id=1' }
const storage = new Map<string, unknown>()
const get = vi.fn()
const send = vi.fn()
const set = vi.fn()
let updated: (id: number, change: { status?: string; url?: string }, tab: chrome.tabs.Tab) => void
let removed: (id: number) => void
let stop: (() => void) | undefined
beforeEach(() => {
  storage.clear(); vi.clearAllMocks()
  get.mockResolvedValue({ id: 7, url: target.url, status: 'complete' })
  send.mockResolvedValue({ ok: true, data: target })
  set.mockImplementation(async (values: Record<string, unknown>) => { for (const [key, value] of Object.entries(values)) storage.set(key, structuredClone(value)) })
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: send },
    tabs: { get, onUpdated: { addListener: (fn: typeof updated) => { updated = fn }, removeListener: vi.fn() }, onRemoved: { addListener: (fn: typeof removed) => { removed = fn }, removeListener: vi.fn() } },
    storage: { local: { get: async (key: string) => ({ [key]: storage.get(key) }), set } },
  })
})
afterEach(() => { stop?.(); stop = undefined; vi.unstubAllGlobals() })

it('retains original title and URL for changed and closed documents across restore', async () => {
  const original = new PageBindings()
  await original.bind('changed', target)
  await original.bind('closed', { ...target, tabId: 8 })
  get.mockImplementation(async (id: number) => { if (id === 8) throw new Error('closed'); return { id, url: 'https://example.test/form?id=2' } })
  const restored = new PageBindings(); await restored.restore(['changed', 'closed'])
  expect(restored.target('changed')).toBeUndefined()
  expect(restored.context('changed')).toMatchObject({ page: { title: target.title, url: target.url }, status: 'changed' })
  expect(restored.context('closed')?.status).toBe('closed')
  expect(send).not.toHaveBeenCalled()
  const again = new PageBindings(); await again.restore(['changed', 'closed'])
  expect(again.context('changed')?.page.url).toBe(target.url)
  expect(again.context('closed')?.page.title).toBe(target.title)
})

it('does not silently bind a reused tab ID with a different document on restore', async () => {
  const original = new PageBindings(); await original.bind('session', target)
  send.mockResolvedValue({ ok: true, data: { ...target, documentId: 'other-browser-document' } })
  const restored = new PageBindings(); await restored.restore(['session'])
  expect(restored.context('session')?.status).toBe('changed')
  expect(restored.target('session')).toBeUndefined()
})

it('reconnects a live same-URL reload with new references and notifies before reconnecting', async () => {
  const bindings = new PageBindings(); await bindings.bind('session', target)
  stop = bindings.watch()
  const states: Array<string | undefined> = []
  bindings.subscribe(() => states.push(bindings.context('session')?.status))
  updated(7, { status: 'loading' }, { id: 7, url: target.url })
  expect(bindings.target('session')).toBeUndefined()
  send.mockResolvedValue({ ok: true, data: { ...target, documentId: 'doc-b' } })
  updated(7, { status: 'complete' }, { id: 7, url: target.url })
  await vi.waitFor(() => expect(bindings.target('session')?.documentId).toBe('doc-b'))
  expect(states).toEqual(['connecting', 'ready'])
})

it('requires explicit binding after URL changes, even if the tab later returns to the original URL', async () => {
  const bindings = new PageBindings(); await bindings.bind('session', target); stop = bindings.watch()
  updated(7, { url: 'https://example.test/form?id=2' }, { id: 7, url: 'https://example.test/form?id=2' })
  updated(7, { status: 'loading' }, { id: 7, url: target.url })
  updated(7, { status: 'complete' }, { id: 7, url: target.url })
  expect(bindings.context('session')?.status).toBe('changed')
  expect(send).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(storage.get('einfach-browser-agent-bindings-v1')).toMatchObject({ session: { requiresRebind: true } }))
  const restored = new PageBindings(); await restored.restore(['session'])
  expect(restored.context('session')?.status).toBe('changed')
  expect(restored.target('session')).toBeUndefined()
  await bindings.bind('session', target)
  expect(bindings.target('session')).toEqual(target)
  const rebound = new PageBindings(); await rebound.restore(['session'])
  expect(rebound.context('session')?.status).toBe('ready')
})

it('does not resurrect a removed binding when an old handshake resolves', async () => {
  const bindings = new PageBindings(); await bindings.bind('session', target); stop = bindings.watch()
  let resolve!: (value: unknown) => void
  send.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
  updated(7, { status: 'complete' }, { id: 7, url: target.url })
  await vi.waitFor(() => expect(send).toHaveBeenCalled())
  await bindings.unbind('session')
  resolve({ ok: true, data: target })
  await Promise.resolve(); await Promise.resolve()
  expect(bindings.context('session')).toBeUndefined()
})

it('marks a closed tab unavailable for calls while retaining its source in history', async () => {
  const bindings = new PageBindings(); await bindings.bind('session', target); stop = bindings.watch()
  removed(7)
  expect(bindings.target('session')).toBeUndefined()
  expect(bindings.context('session')).toMatchObject({ status: 'closed', page: { url: target.url } })
})

it('rolls back a failed durable rebind without changing the prior target', async () => {
  const bindings = new PageBindings(); await bindings.bind('session', target)
  set.mockRejectedValueOnce(new Error('storage unavailable'))
  await expect(bindings.bind('session', { ...target, tabId: 9 })).rejects.toThrow('storage unavailable')
  expect(bindings.target('session')).toEqual(target)
})
