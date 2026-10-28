import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWindowNetworkHost } from './window-host'
import { installWindowNetworkRecorder } from './window-recorder'

const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })
const context = { sessionId: 'session', signal: new AbortController().signal }

describe('window observer lifecycle', () => {
  it('does not hook at host construction and releases the hook on stop', async () => {
    const original = window.fetch
    const base = vi.fn(async () => new Response('ok', { headers: { 'content-type': 'text/plain' } }))
    window.fetch = base
    cleanup.push(() => { window.fetch = original })
    const host = createWindowNetworkHost({ window, targetId: 'target' })
    cleanup.push(() => host.dispose())
    expect(window.fetch).toBe(base)
    const capture = await host.startCapture({ includeBuffered: false }, context)
    expect(window.fetch).not.toBe(base)
    await host.stopCapture({ captureId: capture.captureId }, context)
    expect(window.fetch).toBe(base)
  })

  it('preserves fetch arguments, this, response identity, and Request body', async () => {
    const original = window.fetch
    let receivedThis: unknown
    let argumentCount = 0
    const response = new Response('{"name":"safe"}', { headers: { 'content-type': 'application/json' } })
    window.fetch = function () { receivedThis = this; argumentCount = arguments.length; return Promise.resolve(response) }
    cleanup.push(() => { window.fetch = original })
    const host = createWindowNetworkHost({ window, targetId: 'target' })
    cleanup.push(() => host.dispose())
    const capture = await host.startCapture({}, context)
    const request = new Request('https://example.test/items', { method: 'POST', body: '{"client_secret":"hide","name":"safe"}', headers: { 'content-type': 'application/json' } })
    const returned = await window.fetch(request)
    expect(returned).toBe(response)
    expect(argumentCount).toBe(1)
    expect(receivedThis).toBe(window)
    expect(await request.text()).toContain('client_secret')
    await vi.waitFor(async () => {
      const listed = await host.listRequests({ captureId: capture.captureId }, context)
      expect(listed.requests[0]?.state).toBe('complete')
    })
    const listed = await host.listRequests({ captureId: capture.captureId }, context)
    const details = await host.getRequest({ captureId: capture.captureId, requestId: listed.requests[0]!.requestId }, context)
    expect(details.requestBody).toBe('{"client_secret":"[REDACTED]","name":"safe"}')
  })

  it('clears on pagehide and reinstalls a recorder on persisted pageshow', () => {
    const original = window.fetch
    const base = vi.fn(async () => new Response('ok'))
    window.fetch = base
    cleanup.push(() => { window.fetch = original })
    const recorder = installWindowNetworkRecorder({ window })
    cleanup.push(() => recorder.dispose())
    expect(window.fetch).not.toBe(base)
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
    expect(window.fetch).toBe(base)
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    expect(window.fetch).not.toBe(base)
  })

  it('does not replace a later third-party fetch wrapper during cleanup', () => {
    const original = window.fetch
    const base = vi.fn(async () => new Response('ok'))
    window.fetch = base
    const recorder = installWindowNetworkRecorder({ window })
    const thirdParty = vi.fn(window.fetch)
    window.fetch = thirdParty
    recorder.dispose()
    expect(window.fetch).toBe(thirdParty)
    window.fetch = original
  })

  it('releases an on-demand hook when capture TTL expires', async () => {
    vi.useFakeTimers()
    const original = window.fetch
    const base = vi.fn(async () => new Response('ok'))
    window.fetch = base
    try {
      const host = createWindowNetworkHost({ window, targetId: 'target', maxDurationMs: 1 })
      cleanup.push(() => host.dispose())
      const capture = await host.startCapture({}, context)
      expect(window.fetch).not.toBe(base)
      await vi.advanceTimersByTimeAsync(1)
      expect((await host.listRequests({ captureId: capture.captureId }, context)).capture.active).toBe(false)
      expect(window.fetch).toBe(base)
    } finally {
      vi.useRealTimers()
      window.fetch = original
    }
  })

  it('expires recorder entries on its rolling age timer', async () => {
    vi.useFakeTimers()
    const original = window.fetch
    window.fetch = async () => new Response('ok', { headers: { 'content-type': 'text/plain' } })
    try {
      const recorder = installWindowNetworkRecorder({ window, maxAgeMs: 1 })
      cleanup.push(() => recorder.dispose())
      await window.fetch('/expires')
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(2)
      const host = createWindowNetworkHost({ window, targetId: 'target' })
      cleanup.push(() => host.dispose())
      const capture = await host.startCapture({}, context)
      expect((await host.listRequests({ captureId: capture.captureId }, context)).requests).toHaveLength(0)
    } finally {
      vi.useRealTimers()
      window.fetch = original
    }
  })

  it('does not observe an independent iframe window realm', async () => {
    const frame = document.createElement('iframe')
    document.body.append(frame)
    cleanup.push(() => frame.remove())
    const frameWindow = frame.contentWindow!
    const frameOriginal = frameWindow.fetch
    frameWindow.fetch = async () => new Response('frame')
    cleanup.push(() => { frameWindow.fetch = frameOriginal })
    const host = createWindowNetworkHost({ window, targetId: 'main' })
    cleanup.push(() => host.dispose())
    const capture = await host.startCapture({}, context)
    await frameWindow.fetch('/inside-frame')
    expect((await host.listRequests({ captureId: capture.captureId }, context)).requests).toHaveLength(0)
  })

  it('resets the prune timer when a shorter recorder joins an existing observer', async () => {
    vi.useFakeTimers()
    const original = window.fetch
    window.fetch = async () => new Response('ok', { headers: { 'content-type': 'text/plain' } })
    try {
      const host = createWindowNetworkHost({ window, targetId: 'target' })
      cleanup.push(() => host.dispose())
      await host.startCapture({ includeBuffered: false }, context)
      const recorder = installWindowNetworkRecorder({ window, maxAgeMs: 1 })
      cleanup.push(() => recorder.dispose())
      await window.fetch('/short-age')
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(2)
      const capture = await host.startCapture({}, context)
      expect((await host.listRequests({ captureId: capture.captureId }, context)).requests).toHaveLength(0)
    } finally {
      vi.useRealTimers()
      window.fetch = original
    }
  })

  it('marks a Request clone body pending while its reader is unfinished', async () => {
    const original = window.fetch
    window.fetch = async () => new Response('ok', { headers: { 'content-type': 'text/plain' } })
    cleanup.push(() => { window.fetch = original })
    const host = createWindowNetworkHost({ window, targetId: 'target' })
    cleanup.push(() => host.dispose())
    const capture = await host.startCapture({}, context)
    const stream = new ReadableStream<Uint8Array>({ pull() {} })
    const request = new Request('https://example.test/pending', {
      method: 'POST',
      body: stream,
      headers: { 'content-type': 'text/plain' },
      duplex: 'half',
    } as RequestInit)
    await window.fetch(request)
    const listed = await host.listRequests({ captureId: capture.captureId }, context)
    const details = await host.getRequest({ captureId: capture.captureId, requestId: listed.requests[0]!.requestId }, context)
    expect(details.requestBodyState).toBe('pending')
  })
})
