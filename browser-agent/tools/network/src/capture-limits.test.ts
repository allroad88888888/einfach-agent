import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWindowNetworkHost } from './window-host'
import { installWindowNetworkRecorder } from './window-recorder'

const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })
const ctx = (sessionId: string) => ({ sessionId, signal: new AbortController().signal })

async function responseBody(host: ReturnType<typeof createWindowNetworkHost>, captureId: string, sessionId: string): Promise<string | undefined> {
  await vi.waitFor(async () => {
    const listed = await host.listRequests({ captureId }, ctx(sessionId))
    expect(listed.requests[0]?.state).toBe('complete')
  })
  const listed = await host.listRequests({ captureId }, ctx(sessionId))
  return (await host.getResponse({ captureId, requestId: listed.requests[0]!.requestId }, ctx(sessionId))).body
}

describe('per-capture body limits', () => {
  it('keeps a small host bounded when a large host starts first', async () => {
    const original = window.fetch
    window.fetch = async () => new Response('abcdefghijklmnop', { headers: { 'content-type': 'text/plain' } })
    cleanup.push(() => { window.fetch = original })
    const large = createWindowNetworkHost({ window, targetId: 'large', maxBodyChars: 64 })
    const small = createWindowNetworkHost({ window, targetId: 'small', maxBodyChars: 4 })
    cleanup.push(() => large.dispose(), () => small.dispose())
    const largeCapture = await large.startCapture({ includeBuffered: false }, ctx('large'))
    const smallCapture = await small.startCapture({ includeBuffered: false }, ctx('small'))
    await window.fetch('/large-first')
    expect(await responseBody(large, largeCapture.captureId, 'large')).toBe('abcdefghijklmnop')
    expect(await responseBody(small, smallCapture.captureId, 'small')).toBe('abcd')
  })

  it('lets a later large host use its own limit after a small host', async () => {
    const original = window.fetch
    window.fetch = async () => new Response('abcdefghijklmnop', { headers: { 'content-type': 'text/plain' } })
    cleanup.push(() => { window.fetch = original })
    const small = createWindowNetworkHost({ window, targetId: 'small', maxBodyChars: 4 })
    const large = createWindowNetworkHost({ window, targetId: 'large', maxBodyChars: 64 })
    cleanup.push(() => small.dispose(), () => large.dispose())
    const smallCapture = await small.startCapture({ includeBuffered: false }, ctx('small'))
    const largeCapture = await large.startCapture({ includeBuffered: false }, ctx('large'))
    await window.fetch('/small-first')
    expect(await responseBody(small, smallCapture.captureId, 'small')).toBe('abcd')
    expect(await responseBody(large, largeCapture.captureId, 'large')).toBe('abcdefghijklmnop')
  })

  it('applies a small host limit to a larger recorder buffer', async () => {
    const original = window.fetch
    window.fetch = async () => new Response('abcdefghijklmnop', { headers: { 'content-type': 'text/plain' } })
    cleanup.push(() => { window.fetch = original })
    const recorder = installWindowNetworkRecorder({ window, maxBodyChars: 64 })
    cleanup.push(() => recorder.dispose())
    await window.fetch('/buffered')
    const small = createWindowNetworkHost({ window, targetId: 'small', maxBodyChars: 4 })
    cleanup.push(() => small.dispose())
    const capture = await small.startCapture({}, ctx('small'))
    expect(await responseBody(small, capture.captureId, 'small')).toBe('abcd')
  })
})
