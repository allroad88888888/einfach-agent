import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWindowNetworkHost } from './window-host'
import { installWindowNetworkRecorder } from './window-recorder'

const disposables: Array<{ dispose(): void }> = []
afterEach(() => { while (disposables.length) disposables.pop()!.dispose() })
const ctx = (sessionId: string) => ({ sessionId, signal: new AbortController().signal })

describe('window network host', () => {
  it('copies early recorder fetches and sanitizes credentials', async () => {
    const original = window.fetch
    window.fetch = async () => new Response(JSON.stringify({ token: 'secret', name: 'safe' }), { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'bad' } })
    const recorder = installWindowNetworkRecorder({ window }); disposables.push(recorder)
    const response = await window.fetch('/people?token=secret#fragment', { headers: { authorization: 'Bearer bad', accept: 'application/json' } })
    expect(await response.json()).toEqual({ token: 'secret', name: 'safe' })
    await Promise.resolve(); await Promise.resolve()
    const host = createWindowNetworkHost({ window, targetId: 'target' }); disposables.push(host)
    const capture = await host.startCapture({}, ctx('a'))
    const listed = await host.listRequests({ captureId: capture.captureId }, ctx('a'))
    expect(listed.requests).toHaveLength(1)
    const id = listed.requests[0]!.requestId
    expect((await host.getRequest({ captureId: capture.captureId, requestId: id }, ctx('a'))).url).toContain('token=%5BREDACTED%5D')
    expect(await host.getResponse({ captureId: capture.captureId, requestId: id }, ctx('a'))).toMatchObject({ body: '{"token":"[REDACTED]","name":"safe"}', headers: { 'content-type': 'application/json' } })
    host.dispose(); recorder.dispose(); window.fetch = original
  })

  it('lists the document buffer without starting a capture and keeps its true recording time', async () => {
    const original = window.fetch
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    window.fetch = async () => new Response('early body', { headers: { 'content-type': 'text/plain' } })
    const recorder = installWindowNetworkRecorder({ window, retainForDocument: true }); disposables.push(recorder)
    await window.fetch('/before-agent'); await Promise.resolve(); await Promise.resolve()
    now.mockReturnValue(1_000 + 6 * 60_000)
    const host = createWindowNetworkHost({ window, targetId: 'target' }); disposables.push(host)
    const listed = await host.listRequests({}, ctx('reader'))
    expect(listed.capture).toMatchObject({ scope: 'document', recordingStartedAt: 1_000, startedAt: 1_000, active: true })
    expect(listed.requests.map((request) => request.url).join()).toContain('/before-agent')
    const requestId = listed.requests[0]!.requestId
    await vi.waitFor(async () => expect(await host.getResponse({ captureId: listed.capture.captureId, requestId }, ctx('reader'))).toMatchObject({ body: 'early body' }))
    now.mockRestore(); host.dispose(); recorder.dispose(); window.fetch = original
  })

  it('does not install the base recorder on the first direct list and keeps document and explicit views addressable', async () => {
    const unavailable = createWindowNetworkHost({ window, targetId: 'unavailable' }); disposables.push(unavailable)
    await expect(unavailable.listRequests({}, ctx('reader'))).rejects.toThrow('RECORDER_UNAVAILABLE')
    unavailable.dispose()

    const original = window.fetch
    window.fetch = async () => new Response('ok', { headers: { 'content-type': 'text/plain' } })
    const recorder = installWindowNetworkRecorder({ window, retainForDocument: true }); disposables.push(recorder)
    await window.fetch('/document-view'); await Promise.resolve(); await Promise.resolve()
    const host = createWindowNetworkHost({ window, targetId: 'target' }); disposables.push(host)
    const documentList = await host.listRequests({}, ctx('reader'))
    const explicit = await host.startCapture({}, ctx('reader'))
    expect(explicit.recordingStartedAt).toBeLessThanOrEqual(explicit.startedAt)
    await host.stopCapture({ captureId: explicit.captureId }, ctx('reader'))
    expect((await host.listRequests({ captureId: documentList.capture.captureId }, ctx('reader'))).requests).toHaveLength(1)
    host.dispose(); recorder.dispose(); window.fetch = original
  })

  it('isolates sessions and includeBuffered false', async () => {
    const original = window.fetch; window.fetch = async () => new Response('ok', { headers: { 'content-type': 'text/plain' } })
    const recorder = installWindowNetworkRecorder({ window }); disposables.push(recorder); await window.fetch('/early'); await Promise.resolve()
    const host = createWindowNetworkHost({ window, targetId: 'target' }); disposables.push(host)
    const a = await host.startCapture({ includeBuffered: false }, ctx('a'))
    expect((await host.listRequests({ captureId: a.captureId }, ctx('a'))).requests).toHaveLength(0)
    await expect(host.listRequests({ captureId: a.captureId }, ctx('b'))).rejects.toThrow('CAPTURE_NOT_FOUND')
    await window.fetch('/late'); await Promise.resolve(); await Promise.resolve()
    expect((await host.listRequests({ captureId: a.captureId }, ctx('a'))).requests).toHaveLength(1)
    await host.stopCapture({ captureId: a.captureId }, ctx('a')); await window.fetch('/after-stop')
    expect((await host.listRequests({ captureId: a.captureId }, ctx('a'))).requests).toHaveLength(1)
    host.dispose(); recorder.dispose(); window.fetch = original
  })

  it('settles waits on timeout, abort, and stop', async () => {
    const host = createWindowNetworkHost({ window, targetId: 'target' })
    disposables.push(host)
    const capture = await host.startCapture({}, ctx('a'))
    await expect(host.waitForRequest({ captureId: capture.captureId, timeoutMs: 1 }, ctx('a'))).rejects.toThrow('TIMEOUT')

    const controller = new AbortController()
    const aborted = host.waitForRequest({ captureId: capture.captureId }, { sessionId: 'a', signal: controller.signal })
    controller.abort()
    await expect(aborted).rejects.toThrow('CANCELLED')

    const stopped = host.waitForRequest({ captureId: capture.captureId }, ctx('a'))
    await host.stopCapture({ captureId: capture.captureId }, ctx('a'))
    await expect(stopped).rejects.toThrow('CAPTURE_STOPPED')
  })

  it('rejects invalid direct host input', async () => {
    const host = createWindowNetworkHost({ window, targetId: 'target' })
    disposables.push(host)
    await expect(host.startCapture({ methods: [''] }, ctx('a'))).rejects.toThrow('INVALID_INPUT')
    await expect(host.startCapture({ methods: null } as never, ctx('a'))).rejects.toThrow('INVALID_INPUT')
    await expect(host.startCapture({ methods: 0 } as never, ctx('a'))).rejects.toThrow('INVALID_INPUT')
    await expect(host.listRequests(null as never, ctx('a'))).rejects.toThrow('INVALID_INPUT')
    await expect(host.getRequest({ captureId: 'c', requestId: '' }, ctx('a'))).rejects.toThrow('INVALID_INPUT')
    const capture = await host.startCapture({}, ctx('a'))
    for (const method of [null, 0, Number.NaN, {}]) {
      await expect(host.listRequests({ captureId: capture.captureId, method } as never, ctx('a'))).rejects.toThrow('INVALID_INPUT')
      await expect(host.waitForRequest({ captureId: capture.captureId, method } as never, ctx('a'))).rejects.toThrow('INVALID_INPUT')
    }
  })

  it('does not replace an existing capture when start is already aborted', async () => {
    const host = createWindowNetworkHost({ window, targetId: 'target' })
    disposables.push(host)
    const active = await host.startCapture({}, ctx('a'))
    const controller = new AbortController()
    controller.abort()
    await expect(host.startCapture({}, { sessionId: 'a', signal: controller.signal })).rejects.toThrow('CANCELLED')
    expect((await host.listRequests({ captureId: active.captureId }, ctx('a'))).capture.active).toBe(true)
    expect(active.documentId).toMatch(/^document-/)
    expect(active.documentId).not.toContain(window.location.href)
  })

  it('keeps recorder limits when a larger host shares the same window', async () => {
    const original = window.fetch
    window.fetch = async () => new Response('{"name":"value larger than ten"}', { headers: { 'content-type': 'application/json' } })
    const recorder = installWindowNetworkRecorder({ window, maxRequests: 1, maxBodyChars: 10 })
    disposables.push(recorder)
    await window.fetch('/second')
    await Promise.resolve()
    const host = createWindowNetworkHost({ window, targetId: 'target', maxRequests: 500, maxBodyChars: 65_536 })
    disposables.push(host)
    const capture = await host.startCapture({}, ctx('a'))
    await vi.waitFor(async () => {
      const current = await host.listRequests({ captureId: capture.captureId }, ctx('a'))
      expect(current.requests[0]?.state).toBe('complete')
    })
    const listed = await host.listRequests({ captureId: capture.captureId }, ctx('a'))
    expect(listed.requests).toHaveLength(1)
    const response = await host.getResponse({ captureId: capture.captureId, requestId: listed.requests[0]!.requestId }, ctx('a'))
    expect(response).toMatchObject({ bodyState: 'omitted', truncated: true })
    host.dispose(); recorder.dispose(); window.fetch = original
  })
})
