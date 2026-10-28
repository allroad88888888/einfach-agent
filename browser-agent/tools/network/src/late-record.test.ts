import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWindowNetworkHost } from './window-host'
import { installWindowNetworkRecorder } from './window-recorder'

const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })
const ctx = (sessionId: string) => ({ sessionId, signal: new AbortController().signal })

function deferredResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((done) => { resolve = done })
  return { promise, resolve }
}

describe('late pending isolation', () => {
  it('does not emit a pre-recorder pending request after first recorder installation', async () => {
    const original = window.fetch
    const pending = deferredResponse()
    window.fetch = () => pending.promise
    cleanup.push(() => { window.fetch = original })
    const active = createWindowNetworkHost({ window, targetId: 'active' })
    cleanup.push(() => active.dispose())
    await active.startCapture({ includeBuffered: false }, ctx('active'))
    const business = window.fetch('/before-recorder')
    const recorder = installWindowNetworkRecorder({ window })
    cleanup.push(() => recorder.dispose())
    const reader = createWindowNetworkHost({ window, targetId: 'reader' })
    cleanup.push(() => reader.dispose())
    const capture = await reader.startCapture({ includeBuffered: false }, ctx('reader'))
    pending.resolve(new Response('late', { headers: { 'content-type': 'text/plain' } }))
    await business
    await Promise.resolve()
    expect((await reader.listRequests({ captureId: capture.captureId }, ctx('reader'))).requests).toHaveLength(0)
  })

  it('does not revive a pending request after rolling expiry', async () => {
    vi.useFakeTimers()
    const original = window.fetch
    const pending = deferredResponse()
    window.fetch = () => pending.promise
    try {
      const recorder = installWindowNetworkRecorder({ window, maxAgeMs: 1 })
      cleanup.push(() => recorder.dispose())
      const business = window.fetch('/expires-pending')
      await vi.advanceTimersByTimeAsync(2)
      const host = createWindowNetworkHost({ window, targetId: 'reader' })
      cleanup.push(() => host.dispose())
      const capture = await host.startCapture({ includeBuffered: false }, ctx('reader'))
      pending.resolve(new Response('late', { headers: { 'content-type': 'text/plain' } }))
      await business
      await Promise.resolve()
      expect((await host.listRequests({ captureId: capture.captureId }, ctx('reader'))).requests).toHaveLength(0)
    } finally {
      vi.useRealTimers()
      window.fetch = original
    }
  })

  it('does not revive a pending request after capacity eviction', async () => {
    const original = window.fetch
    const pending = deferredResponse()
    window.fetch = (input) => String(input).includes('old')
      ? pending.promise
      : Promise.resolve(new Response('new', { headers: { 'content-type': 'text/plain' } }))
    cleanup.push(() => { window.fetch = original })
    const recorder = installWindowNetworkRecorder({ window, maxRequests: 1 })
    cleanup.push(() => recorder.dispose())
    const oldBusiness = window.fetch('/old')
    await window.fetch('/new')
    const host = createWindowNetworkHost({ window, targetId: 'reader' })
    cleanup.push(() => host.dispose())
    const capture = await host.startCapture({ includeBuffered: false }, ctx('reader'))
    pending.resolve(new Response('old-late', { headers: { 'content-type': 'text/plain' } }))
    await oldBusiness
    await Promise.resolve()
    expect((await host.listRequests({ captureId: capture.captureId }, ctx('reader'))).requests).toHaveLength(0)
  })
})
