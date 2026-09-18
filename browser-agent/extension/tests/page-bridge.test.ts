import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExtensionPageBridge, bindActiveTab } from '../src/page-bridge'
import type { TargetBinding } from '../src/protocol'

const target: TargetBinding = { tabId: 7, frameId: 0, targetId: 'main-frame', documentId: 'doc-1', revision: 1, title: 'Fixture', url: 'https://fixture.test/' }
const sendMessage = vi.fn()
const storage = new Map<string, unknown>()

beforeEach(() => {
  sendMessage.mockReset(); storage.clear()
  vi.stubGlobal('chrome', { runtime: { sendMessage }, storage: { local: { get: async (key: string) => ({ [key]: storage.get(key) }), set: async (items: Record<string, unknown>) => { for (const [key, value] of Object.entries(items)) storage.set(key, value) } } } })
})

it('reports restricted pages and denied origin permission without injecting a script', async () => {
  vi.stubGlobal('chrome', { tabs: { query: vi.fn().mockResolvedValue([{ id: 1, url: 'chrome://settings' }]) } })
  await expect(bindActiveTab()).rejects.toThrow(/restricted/)
  const executeScript = vi.fn()
  vi.stubGlobal('chrome', { tabs: { query: vi.fn().mockResolvedValue([{ id: 2, url: 'https://denied.test/form' }]) }, permissions: { contains: vi.fn().mockResolvedValue(false), request: vi.fn().mockResolvedValue(false) }, scripting: { executeScript }, runtime: { sendMessage } })
  await expect(bindActiveTab()).rejects.toThrow(/denied/)
  expect(executeScript).not.toHaveBeenCalled()
})

describe('ExtensionPageBridge', () => {
  it('pins each session to its own document and rejects a stale PageRef', async () => {
    const bridge = new ExtensionPageBridge(); bridge.bind('session-a', target)
    sendMessage.mockResolvedValue({ ok: true, data: { page: { targetId: 'main-frame', documentId: 'doc-1', revision: 1 }, fields: [] } })
    await expect(bridge.readForm({ sessionId: 'session-a', signal: new AbortController().signal })).resolves.toMatchObject({ page: { documentId: 'doc-1' } })
    await expect(bridge.validateForm({ page: { targetId: 'main-frame', documentId: 'old', revision: 1 } }, { sessionId: 'session-a', signal: new AbortController().signal })).rejects.toThrow(/stale/)
  })

  it('does not send a pre-cancelled call and rejects a late success after in-flight cancellation', async () => {
    const bridge = new ExtensionPageBridge(); bridge.bind('session-a', target)
    const alreadyCancelled = new AbortController(); alreadyCancelled.abort()
    await expect(bridge.readForm({ sessionId: 'session-a', signal: alreadyCancelled.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(sendMessage).not.toHaveBeenCalled()
    let resolve!: (value: unknown) => void
    sendMessage.mockImplementationOnce(() => new Promise((done) => { resolve = done })).mockResolvedValue({ ok: true, data: [] })
    const controller = new AbortController()
    const running = bridge.fillFields({ page: { targetId: 'main-frame', documentId: 'doc-1', revision: 1 }, values: [{ id: 'name', value: 'Ada' }] }, { sessionId: 'session-a', signal: controller.signal })
    controller.abort(); resolve({ ok: true, data: [{ id: 'name', ok: true, value: 'Ada' }] })
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(sendMessage.mock.calls[1][0]).toMatchObject({ kind: 'cancel-page-call' })
  })

  it('marks a lost write result as unknown and does not replay it', async () => {
    const bridge = new ExtensionPageBridge(); bridge.bind('session-a', target)
    sendMessage.mockResolvedValue({ ok: false, code: 'CONTENT_SCRIPT_UNAVAILABLE', error: 'reply lost', unknownResult: true })
    await expect(bridge.fillFields({ page: { targetId: 'main-frame', documentId: 'doc-1', revision: 1 }, values: [{ id: 'name', value: 'Ada' }] }, { sessionId: 'session-a', signal: new AbortController().signal })).rejects.toThrow(/unknown.*not be replayed/i)
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('restores only an unchanged document after the side panel reopens', async () => {
    const original = new ExtensionPageBridge(); original.bind('keep', target); original.bind('stale', { ...target, tabId: 8, documentId: 'old' })
    await Promise.resolve()
    sendMessage.mockImplementation(async (message) => ({ ok: true, data: message.tabId === 7 ? target : { ...target, tabId: 8, documentId: 'new' } }))
    const restored = new ExtensionPageBridge(); await restored.restore(['keep', 'stale'])
    expect(restored.target('keep')).toEqual(target); expect(restored.target('stale')).toBeUndefined()
  })
})
