import { beforeEach, expect, it, vi } from 'vitest'
import type { TargetBinding } from '../src/protocol'

const target: TargetBinding = { tabId: 7, frameId: 0, targetId: 'main-frame', documentId: 'logical-doc', revision: 1, title: 'Page', url: 'https://allowed.test/' }
let onMessage!: (message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => boolean | void
let onActionClicked!: (tab: chrome.tabs.Tab) => void
const executeScript = vi.fn()
const sendMessage = vi.fn()
const registerContentScripts = vi.fn()
const setPanelBehavior = vi.fn()
const openPanel = vi.fn()

beforeEach(async () => {
  vi.resetModules(); executeScript.mockReset(); sendMessage.mockReset(); registerContentScripts.mockReset().mockResolvedValue(undefined)
  setPanelBehavior.mockReset().mockResolvedValue(undefined); openPanel.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('chrome', {
    runtime: { id: 'extension-id', getURL: () => 'chrome-extension://extension-id/', onMessage: { addListener: (listener: typeof onMessage) => { onMessage = listener } }, onInstalled: { addListener: vi.fn() }, onStartup: { addListener: vi.fn() } },
    action: { onClicked: { addListener: (listener: typeof onActionClicked) => { onActionClicked = listener } } },
    sidePanel: { setPanelBehavior, open: openPanel },
    permissions: { getAll: vi.fn().mockResolvedValue({ origins: ['https://allowed.test/*'] }), onAdded: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() } },
    scripting: { executeScript, unregisterContentScripts: vi.fn().mockResolvedValue(undefined), registerContentScripts, getRegisteredContentScripts: vi.fn().mockResolvedValue([]) },
    tabs: { sendMessage, query: vi.fn().mockResolvedValue([]) },
  })
  await import('../src/service-worker')
})

it('disables automatic action toggling and opens the clicked window immediately', () => {
  expect(setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: false })
  onActionClicked({ id: 7, windowId: 23 })
  expect(openPanel).toHaveBeenCalledWith({ windowId: 23 })
})

it('contains side-panel setup and open rejections', async () => {
  setPanelBehavior.mockRejectedValueOnce(new Error('setting rejected'))
  openPanel.mockRejectedValueOnce(new Error('open rejected'))
  vi.resetModules()
  await expect(import('../src/service-worker')).resolves.toBeDefined()
  expect(() => onActionClicked({ id: 7, windowId: 23 })).not.toThrow()
  await Promise.resolve()
})

it('coalesces registration across concurrent handshakes while current-document injection stays idempotent', async () => {
  executeScript.mockResolvedValue([]); sendMessage.mockResolvedValue({ ok: true, data: target })
  await Promise.all([dispatch({ channel: 'einfach-browser-agent-v1', kind: 'handshake', tabId: 7, frameId: 0 }), dispatch({ channel: 'einfach-browser-agent-v1', kind: 'handshake', tabId: 7, frameId: 0 })])
  expect(registerContentScripts).toHaveBeenCalledTimes(1)
  expect(executeScript).toHaveBeenCalledTimes(4)
})

it('injects both current-document worlds during handshake and rejects an extension-external sender', async () => {
  executeScript.mockResolvedValue([]); sendMessage.mockResolvedValue({ ok: true, data: target })
  const response = await dispatch({ channel: 'einfach-browser-agent-v1', kind: 'handshake', tabId: 7, frameId: 0 })
  expect(response).toEqual({ ok: true, data: target })
  expect(executeScript.mock.calls.map(([call]) => [call.world, call.files])).toEqual([
    ['ISOLATED', ['content-script.js']], ['MAIN', ['network-main.js']],
  ])
  expect(await dispatch({ channel: 'einfach-browser-agent-v1', kind: 'handshake', tabId: 7, frameId: 0 }, { id: 'other', url: 'https://evil.test/' })).toMatchObject({ ok: false, code: 'UNTRUSTED_SENDER' })
})

it('pins a network call to the native document id returned by the isolated probe', async () => {
  const capture = { captureId: 'c', targetId: 'main-frame', documentId: 'logical-doc', active: true, startedAt: 1, recordingStartedAt: 1, scope: 'capture', count: 0, droppedCount: 0 }
  executeScript.mockResolvedValueOnce([{ frameId: 0, documentId: 'native-doc', result: { targetId: 'main-frame', documentId: 'logical-doc', revision: 1, url: target.url } }]).mockResolvedValueOnce([{ frameId: 0, documentId: 'native-doc', result: capture }])
  const response = await dispatch({ channel: 'einfach-browser-agent-v1', kind: 'network-call', requestId: 'r', target, sessionId: 's', method: 'startCapture', input: {} })
  expect(response).toEqual({ ok: true, data: capture })
  expect(executeScript.mock.calls[1][0]).toMatchObject({ world: 'MAIN', target: { tabId: 7, documentIds: ['native-doc'] }, args: ['s', 'main-frame', 'logical-doc', 'r', 'startCapture', {}] })
})

it('preserves MAIN call results and recorder errors through the full handshake route', async () => {
  executeScript.mockResolvedValue([]); sendMessage.mockResolvedValue({ ok: true, data: target })
  await expect(dispatch({ channel: 'einfach-browser-agent-v1', kind: 'handshake', tabId: 7, frameId: 0 })).resolves.toMatchObject({ ok: true })
  const probe = { frameId: 0, documentId: 'native-doc', result: { targetId: 'main-frame', documentId: 'logical-doc', revision: 1, url: target.url } }
  const documentList = { capture: { captureId: 'document-1', targetId: 'main-frame', documentId: 'logical-doc', active: true, startedAt: 1, recordingStartedAt: 1, scope: 'document', count: 1, droppedCount: 0 }, requests: [{ requestId: 'r1', url: 'https://allowed.test/api', method: 'GET', resourceType: 'fetch', state: 'complete', startedAt: 2, status: 200 }] }
  ;(globalThis as Record<string, unknown>).__einfachBrowserAgentNetworkGateway__ = { call: vi.fn().mockResolvedValue(documentList) }
  executeScript.mockResolvedValueOnce([probe]).mockImplementationOnce(async (details) => [{ frameId: 0, documentId: 'native-doc', result: await details.func(...details.args) }])
  await expect(dispatch(networkCall('listRequests', {}))).resolves.toEqual({ ok: true, data: documentList })

  ;(globalThis as Record<string, unknown>).__einfachBrowserAgentNetworkGateway__ = { call: vi.fn().mockRejectedValue(Object.assign(new Error('RECORDER_UNAVAILABLE'), { code: 'RECORDER_UNAVAILABLE' })) }
  executeScript.mockResolvedValueOnce([probe]).mockImplementationOnce(async (details) => [{ frameId: 0, documentId: 'native-doc', result: await details.func(...details.args) }])
  await expect(dispatch(networkCall('listRequests', {}))).resolves.toEqual({ ok: false, code: 'NETWORK_RECORDER_UNAVAILABLE', error: 'RECORDER_UNAVAILABLE' })
  delete (globalThis as Record<string, unknown>).__einfachBrowserAgentNetworkGateway__
})

it('returns a fixed error when network executeScript rejects instead of leaving the reply pending', async () => {
  executeScript.mockRejectedValueOnce(new Error('tab navigated'))
  await expect(dispatch(networkCall('startCapture', {}))).resolves.toMatchObject({ ok: false, code: 'CONTENT_SCRIPT_UNAVAILABLE', error: 'tab navigated' })
})

it('validates nested DOM results and marks lost DOM writes as unknown', async () => {
  const page = { targetId: 'main-frame', documentId: 'logical-doc', revision: 1, url: target.url }
  sendMessage.mockResolvedValueOnce({ ok: true, data: { page, nodes: [{ ref: 'dom-1', tag: 'button', name: 'Open', attributes: { role: 'button' } }], truncated: false } })
  await expect(dispatch({ channel: 'einfach-browser-agent-v1', kind: 'page-call', requestId: 'read', target, sessionId: 's', method: 'readDom', input: {} })).resolves.toMatchObject({ ok: true })
  sendMessage.mockResolvedValueOnce({ ok: true, data: { page, nodes: [{ ref: 'dom-1', tag: 'button', name: 'Open', attributes: { role: 7 } }], truncated: false } })
  await expect(dispatch({ channel: 'einfach-browser-agent-v1', kind: 'page-call', requestId: 'bad', target, sessionId: 's', method: 'readDom', input: {} })).resolves.toMatchObject({ ok: false, code: 'CONTENT_SCRIPT_UNAVAILABLE' })
  sendMessage.mockRejectedValueOnce(new Error('reply lost'))
  await expect(dispatch({ channel: 'einfach-browser-agent-v1', kind: 'page-call', requestId: 'write', target, sessionId: 's', method: 'clickDom', input: { page, ref: 'dom-1' } })).resolves.toMatchObject({ ok: false, unknownResult: true })
})

it('rejects oversized and invalid MAIN-world results', async () => {
  const probe = { frameId: 0, documentId: 'native-doc', result: { targetId: 'main-frame', documentId: 'logical-doc', revision: 1, url: target.url } }
  const oversized = { capture: { captureId: 'c', targetId: 'main-frame', documentId: 'logical-doc', active: true, startedAt: 1, recordingStartedAt: 1, scope: 'capture', count: 101, droppedCount: 0 }, requests: Array.from({ length: 101 }, () => ({ requestId: 'r', url: 'https://example.test/', method: 'GET', resourceType: 'fetch', state: 'complete', startedAt: 1 })) }
  executeScript.mockResolvedValueOnce([probe]).mockResolvedValueOnce([{ frameId: 0, documentId: 'native-doc', result: oversized }])
  await expect(dispatch(networkCall('listRequests', { captureId: 'c' }))).resolves.toMatchObject({ ok: false, code: 'INVALID_NETWORK_RESULT' })
  executeScript.mockResolvedValueOnce([probe]).mockResolvedValueOnce([{ frameId: 0, documentId: 'native-doc', result: { requestId: 'r', url: 'u', headers: { x: 'x'.repeat(8193) }, body: 'x'.repeat(65537), bodyState: 'captured', truncated: false } }])
  await expect(dispatch(networkCall('getResponse', { captureId: 'c', requestId: 'r' }))).resolves.toMatchObject({ ok: false, code: 'INVALID_NETWORK_RESULT' })
  executeScript.mockResolvedValueOnce([probe]).mockResolvedValueOnce([{ frameId: 0, documentId: 'native-doc', result: { captureId: 'c', targetId: 'main-frame', documentId: 'logical-doc', active: true, startedAt: Number.NaN, count: -1, droppedCount: 0 } }])
  await expect(dispatch(networkCall('startCapture', {}))).resolves.toMatchObject({ ok: false, code: 'INVALID_NETWORK_RESULT' })
})

it('accepts a legal empty header value but rejects an empty header name', async () => {
  const probe = { frameId: 0, documentId: 'native-doc', result: { targetId: 'main-frame', documentId: 'logical-doc', revision: 1, url: target.url } }
  const response = (headers: Record<string, string>) => ({ requestId: 'r', url: 'https://example.test/', headers, bodyState: 'captured', truncated: false })
  executeScript.mockResolvedValueOnce([probe]).mockResolvedValueOnce([{ frameId: 0, documentId: 'native-doc', result: response({ 'x-empty': '' }) }])
  await expect(dispatch(networkCall('getResponse', { captureId: 'c', requestId: 'r' }))).resolves.toMatchObject({ ok: true })
  executeScript.mockResolvedValueOnce([probe]).mockResolvedValueOnce([{ frameId: 0, documentId: 'native-doc', result: response({ '': 'value' }) }])
  await expect(dispatch(networkCall('getResponse', { captureId: 'c', requestId: 'r' }))).resolves.toMatchObject({ ok: false, code: 'INVALID_NETWORK_RESULT' })
})

function dispatch(message: unknown, sender: chrome.runtime.MessageSender = { id: 'extension-id', url: 'chrome-extension://extension-id/sidepanel.html' }): Promise<unknown> {
  return new Promise((resolve) => { onMessage(message, sender, resolve) })
}
function networkCall(method: string, input: unknown) { return { channel: 'einfach-browser-agent-v1', kind: 'network-call', requestId: 'r', target, sessionId: 's', method, input } }

it('rejects network reads for a different same-document URL before MAIN dispatch', async () => {
  executeScript.mockResolvedValueOnce([{ frameId: 0, documentId: 'native-doc', result: { targetId: target.targetId, documentId: target.documentId, revision: 1, url: 'https://allowed.test/other' } }])
  await expect(dispatch({ channel: 'einfach-browser-agent-v1', kind: 'network-call', requestId: 'r', target, sessionId: 's', method: 'listRequests', input: {} })).resolves.toMatchObject({ ok: false, code: 'PAGE_URL_CHANGED' })
  expect(executeScript).toHaveBeenCalledTimes(1)
})
