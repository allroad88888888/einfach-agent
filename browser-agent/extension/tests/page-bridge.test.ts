import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExtensionPageBridge, bindActiveTab } from '../src/page-bridge'
import { isRequest, type TargetBinding } from '../src/protocol'

const target: TargetBinding = { tabId: 7, frameId: 0, targetId: 'main-frame', documentId: 'doc-1', revision: 1, title: 'Fixture', url: 'https://fixture.test/' }
const sendMessage = vi.fn()
const storage = new Map<string, unknown>()

beforeEach(() => {
  sendMessage.mockReset(); storage.clear()
  vi.stubGlobal('chrome', { runtime: { sendMessage }, tabs: { get: async (id: number) => ({ id, url: target.url }) }, storage: { local: { get: async (key: string) => ({ [key]: storage.get(key) }), set: async (items: Record<string, unknown>) => { for (const [key, value] of Object.entries(items)) storage.set(key, value) } } } })
})

describe('bindActiveTab', () => {
  it('requests access for the selected tab when its URL is unavailable and never handshakes', async () => {
    const addHostAccessRequest = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('chrome', { tabs: { query: vi.fn().mockResolvedValue([{ id: 0 }]) }, permissions: { addHostAccessRequest }, runtime: { sendMessage } })
    await expect(bindActiveTab()).rejects.toThrow(/扩展菜单.*再次新建会话/)
    expect(addHostAccessRequest).toHaveBeenCalledWith({ tabId: 0 })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('uses the newly visible URL and permission on the next attempt', async () => {
    const query = vi.fn().mockResolvedValue([{ id: 7 }]).mockResolvedValueOnce([{ id: 7 }])
    const addHostAccessRequest = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('chrome', { tabs: { query }, permissions: { addHostAccessRequest }, runtime: { sendMessage } })
    await expect(bindActiveTab()).rejects.toThrow(/扩展菜单/)
    query.mockResolvedValue([{ id: 7, url: target.url }])
    sendMessage.mockResolvedValue({ ok: true, data: target })
    Object.assign(chrome.permissions, { contains: vi.fn().mockResolvedValue(true), request: vi.fn() })
    await expect(bindActiveTab()).resolves.toEqual(target)
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it('falls back only when the current window has no active tab', async () => {
    const query = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 7, url: target.url }])
    sendMessage.mockResolvedValue({ ok: true, data: target })
    vi.stubGlobal('chrome', { tabs: { query }, permissions: { contains: vi.fn().mockResolvedValue(true), request: vi.fn() }, runtime: { sendMessage } })
    await expect(bindActiveTab()).resolves.toEqual(target)
    expect(query).toHaveBeenNthCalledWith(2, { active: true, lastFocusedWindow: true })

    query.mockReset().mockResolvedValue([{ id: 7 }])
    Object.assign(chrome.permissions, { addHostAccessRequest: vi.fn().mockResolvedValue(undefined) })
    await expect(bindActiveTab()).rejects.toThrow(/扩展菜单/)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('reports no tab and gives an actionable fallback when the host request API fails', async () => {
    vi.stubGlobal('chrome', { tabs: { query: vi.fn().mockResolvedValue([]) }, permissions: {}, runtime: { sendMessage } })
    await expect(bindActiveTab()).rejects.toThrow(/没有可绑定的活动网页/)
    vi.stubGlobal('chrome', { tabs: { query: vi.fn().mockResolvedValue([{ id: 3 }]) }, permissions: {}, runtime: { sendMessage } })
    await expect(bindActiveTab()).rejects.toThrow(/点击工具栏的插件图标.*HTTP\/HTTPS/)
    vi.stubGlobal('chrome', { tabs: { query: vi.fn().mockResolvedValue([{ id: 3 }]) }, permissions: { addHostAccessRequest: vi.fn().mockRejectedValue(new Error('not available')) }, runtime: { sendMessage } })
    await expect(bindActiveTab()).rejects.toThrow(/点击工具栏的插件图标.*HTTP\/HTTPS/)
  })

  it('requests a newly disclosed origin and then handshakes', async () => {
    const request = vi.fn().mockResolvedValue(true)
    sendMessage.mockResolvedValue({ ok: true, data: target })
    vi.stubGlobal('chrome', { tabs: { query: vi.fn().mockResolvedValue([{ id: 7, url: target.url }]) }, permissions: { contains: vi.fn().mockResolvedValue(false), request }, runtime: { sendMessage } })
    await expect(bindActiveTab()).resolves.toEqual(target)
    expect(request).toHaveBeenCalledWith({ origins: ['https://fixture.test/*'] })
    expect(sendMessage).toHaveBeenCalledWith({ channel: 'einfach-browser-agent-v1', kind: 'handshake', tabId: 7, frameId: 0 })
  })

  it('reports restricted, malformed, denied, invalid, and mismatched targets in Chinese', async () => {
    vi.stubGlobal('chrome', { tabs: { query: vi.fn().mockResolvedValue([{ id: 1, url: 'chrome://settings' }]) }, permissions: {}, runtime: { sendMessage } })
    await expect(bindActiveTab()).rejects.toThrow(/受浏览器限制/)
    vi.stubGlobal('chrome', { tabs: { query: vi.fn().mockResolvedValue([{ id: 1, url: 'not a url' }]) }, permissions: {}, runtime: { sendMessage } })
    await expect(bindActiveTab()).rejects.toThrow(/地址无效/)
    vi.stubGlobal('chrome', { tabs: { query: vi.fn().mockResolvedValue([{ id: 2, url: 'https://denied.test/form' }]) }, permissions: { contains: vi.fn().mockResolvedValue(false), request: vi.fn().mockResolvedValue(false) }, runtime: { sendMessage } })
    await expect(bindActiveTab()).rejects.toThrow(/未获得.*访问权限/)
    Object.assign(chrome.permissions, { contains: vi.fn().mockResolvedValue(true) })
    sendMessage.mockResolvedValueOnce({ ok: true, data: {} }).mockResolvedValueOnce({ ok: true, data: { ...target, tabId: 99 } })
    await expect(bindActiveTab()).rejects.toThrow(/无效的绑定信息/)
    await expect(bindActiveTab()).rejects.toThrow(/不匹配/)
  })
})

describe('ExtensionPageBridge', () => {
  it('pins each session to its own document and rejects a stale PageRef', async () => {
    const bridge = new ExtensionPageBridge(); bridge.bind('session-a', target)
    sendMessage.mockResolvedValue({ ok: true, data: { page: { targetId: 'main-frame', documentId: 'doc-1', revision: 1 }, fields: [] } })
    await expect(bridge.readForm({ sessionId: 'session-a', signal: new AbortController().signal })).resolves.toMatchObject({ page: { documentId: 'doc-1' } })
    await expect(bridge.validateForm({ page: { targetId: 'main-frame', documentId: 'old', revision: 1 } }, { sessionId: 'session-a', signal: new AbortController().signal })).rejects.toThrow(/stale/)
  })

  it('routes page and table reads through the pinned target', async () => {
    const bridge = new ExtensionPageBridge(); bridge.bind('session-a', target)
    const page = { targetId: 'main-frame', documentId: 'doc-1', revision: 1 }
    sendMessage.mockResolvedValueOnce({ ok: true, data: { page, title: 'Fixture', url: target.url, text: 'Orders', truncated: false, tables: [{ id: 'table-1', caption: 'Orders', rowCount: 2, columnCount: 2 }] } })
      .mockResolvedValueOnce({ ok: true, data: { page, tableId: 'table-1', headers: ['Name'], rows: [['Ada']], truncated: false } })
    await expect(bridge.readPage!({ maxChars: 50 }, { sessionId: 'session-a', signal: new AbortController().signal })).resolves.toMatchObject({ text: 'Orders' })
    await expect(bridge.readTable!({ page, tableId: 'table-1' }, { sessionId: 'session-a', signal: new AbortController().signal })).resolves.toMatchObject({ rows: [['Ada']] })
    expect(sendMessage.mock.calls.map(([message]) => message.method)).toEqual(['readPage', 'readTable'])
    await expect(bridge.readTable!({ page: { ...page, documentId: 'stale' }, tableId: 'table-1' }, { sessionId: 'session-a', signal: new AbortController().signal })).rejects.toThrow(/stale/)
  })

  it('routes DOM reads and writes through the same pinned document and cancellation channel', async () => {
    const bridge = new ExtensionPageBridge(); bridge.bind('session-a', target)
    const page = { targetId: 'main-frame', documentId: 'doc-1', revision: 1 }
    const ctx = { sessionId: 'session-a', signal: new AbortController().signal }
    sendMessage.mockResolvedValueOnce({ ok: true, data: { page, nodes: [{ ref: 'dom-1', tag: 'button', name: 'Open' }], truncated: false } })
      .mockResolvedValueOnce({ ok: true, data: { page, ref: 'dom-1', dispatched: true } })
    await expect(bridge.readDom({ selector: 'button' }, ctx)).resolves.toMatchObject({ nodes: [{ ref: 'dom-1' }] })
    await expect(bridge.clickDom({ page, ref: 'dom-1' }, ctx)).resolves.toMatchObject({ dispatched: true })
    expect(sendMessage.mock.calls.map(([message]) => message.method)).toEqual(['readDom', 'clickDom'])
    await expect(bridge.waitForDom({ page: { ...page, documentId: 'stale' }, text: 'Open' }, ctx)).rejects.toThrow(/stale/)
  })

  it('does not send a pre-cancelled call and rejects a late success after in-flight cancellation', async () => {
    const bridge = new ExtensionPageBridge(); bridge.bind('session-a', target)
    const alreadyCancelled = new AbortController(); alreadyCancelled.abort()
    await expect(bridge.readPage!({}, { sessionId: 'session-a', signal: alreadyCancelled.signal })).rejects.toMatchObject({ name: 'AbortError' })
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

it('rejects unknown page methods at the protocol boundary', () => {
  expect(isRequest({ channel: 'einfach-browser-agent-v1', kind: 'page-call', requestId: '1', target, sessionId: 'a', method: 'submitForm' })).toBe(false)
  expect(isRequest({ channel: 'einfach-browser-agent-v1', kind: 'page-call', requestId: '1', target, sessionId: 'a', method: 'readPage', input: {} })).toBe(true)
  expect(isRequest({ channel: 'einfach-browser-agent-v1', kind: 'page-call', requestId: '1', target, sessionId: 'a', method: 'waitForDom', input: {} })).toBe(true)
})
