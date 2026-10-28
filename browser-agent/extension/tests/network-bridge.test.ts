import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExtensionNetworkBridge } from '../src/network-bridge'
import type { TargetBinding } from '../src/protocol'

const a: TargetBinding = { tabId: 1, frameId: 0, targetId: 'main-frame', documentId: 'doc-a', revision: 1, title: 'A', url: 'https://a.test/' }
const b: TargetBinding = { ...a, tabId: 2, documentId: 'doc-b', title: 'B', url: 'https://b.test/' }
const sendMessage = vi.fn()
const pages = { target: (sessionId: string) => sessionId === 'a' ? a : sessionId === 'b' ? b : undefined }

beforeEach(() => {
  sendMessage.mockReset()
  vi.stubGlobal('chrome', { runtime: { sendMessage } })
})

describe('ExtensionNetworkBridge', () => {
  it('implements every method and keeps sessions pinned to different targets', async () => {
    const bridge = new ExtensionNetworkBridge(pages)
    sendMessage.mockImplementation(async (message) => ({ ok: true, data: resultFor(message.method, message.target) }))
    const signal = new AbortController().signal
    const capture = await bridge.startCapture({ includeBuffered: true }, { sessionId: 'a', signal })
    await bridge.listRequests({ captureId: capture.captureId }, { sessionId: 'a', signal })
    await bridge.getRequest({ captureId: capture.captureId, requestId: 'r' }, { sessionId: 'a', signal })
    await bridge.getResponse({ captureId: capture.captureId, requestId: 'r' }, { sessionId: 'a', signal })
    await bridge.waitForRequest({ captureId: capture.captureId }, { sessionId: 'b', signal })
    await bridge.stopCapture({ captureId: capture.captureId }, { sessionId: 'a', signal })
    expect(sendMessage.mock.calls.map(([message]) => message.method)).toEqual(['startCapture', 'listRequests', 'getRequest', 'getResponse', 'waitForRequest', 'stopCapture'])
    expect(sendMessage.mock.calls[0][0].target).toEqual(a)
    expect(sendMessage.mock.calls[4][0].target).toEqual(b)
    expect(JSON.stringify(sendMessage.mock.calls)).not.toMatch(/apiKey|credential|instructions/)
  })

  it('fails closed without a binding and rejects immediately on abort while dropping late success', async () => {
    const bridge = new ExtensionNetworkBridge(pages)
    await expect(bridge.startCapture({}, { sessionId: 'missing', signal: new AbortController().signal })).rejects.toThrow(/not bound/)
    let resolve!: (value: unknown) => void
    sendMessage.mockImplementationOnce(() => new Promise((done) => { resolve = done })).mockResolvedValue({ ok: true, data: null })
    const controller = new AbortController()
    const pending = bridge.startCapture({}, { sessionId: 'a', signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    resolve({ ok: true, data: resultFor('startCapture', a) })
    await Promise.resolve()
    expect(sendMessage.mock.calls[1][0]).toMatchObject({ kind: 'cancel-network-call', sessionId: 'a', target: a })
  })

  it('stops captures it owns on dispose', async () => {
    const bridge = new ExtensionNetworkBridge(pages)
    sendMessage.mockImplementation(async (message) => ({ ok: true, data: resultFor(message.method, message.target) }))
    await bridge.startCapture({}, { sessionId: 'a', signal: new AbortController().signal })
    sendMessage.mockClear()
    await bridge.dispose()
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'network-call', method: 'stopCapture', sessionId: 'a' }))
  })
})

function summary() { return { requestId: 'r', url: 'https://example.test/', method: 'GET', resourceType: 'fetch' as const, state: 'complete' as const, startedAt: 1, status: 200 } }
function capture(target: TargetBinding) { return { captureId: 'c', targetId: target.targetId, documentId: target.documentId, active: true, startedAt: 1, recordingStartedAt: 1, scope: 'capture' as const, count: 1, droppedCount: 0 } }
function resultFor(method: string, target: TargetBinding): unknown {
  if (method === 'listRequests') return { capture: capture(target), requests: [summary()] }
  if (method === 'getRequest') return { ...summary(), requestHeaders: {}, requestBodyState: 'omitted', requestBodyTruncated: false }
  if (method === 'getResponse') return { requestId: 'r', url: 'https://example.test/', status: 200, headers: {}, bodyState: 'captured', body: 'ok', truncated: false }
  if (method === 'waitForRequest') return summary()
  return capture(target)
}
