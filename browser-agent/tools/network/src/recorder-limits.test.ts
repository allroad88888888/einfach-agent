import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWindowNetworkHost } from './window-host'
import { installWindowNetworkRecorder } from './window-recorder'

const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })
const ctx = (sessionId: string) => ({ sessionId, signal: new AbortController().signal })

function installFetch(body = '{"name":"a value longer than ten"}'): void {
  const original = window.fetch
  window.fetch = async () => new Response(body, { headers: { 'content-type': 'application/json' } })
  cleanup.push(() => { window.fetch = original })
}

async function buffered(host: ReturnType<typeof createWindowNetworkHost>, sessionId: string) {
  const capture = await host.startCapture({}, ctx(sessionId))
  await vi.waitFor(async () => {
    const requests = (await host.listRequests({ captureId: capture.captureId }, ctx(sessionId))).requests
    expect(requests.every((request) => request.state === 'complete')).toBe(true)
  })
  return { capture, requests: (await host.listRequests({ captureId: capture.captureId }, ctx(sessionId))).requests }
}

async function expectOneOmitted(host: ReturnType<typeof createWindowNetworkHost>, sessionId: string): Promise<void> {
  const { capture, requests } = await buffered(host, sessionId)
  expect(requests).toHaveLength(1)
  const response = await host.getResponse({ captureId: capture.captureId, requestId: requests[0]!.requestId }, ctx(sessionId))
  expect(response).toMatchObject({ bodyState: 'omitted', truncated: true })
}

describe('shared recorder limits', () => {
  it('does not let a later wide host enlarge an existing recorder', async () => {
    installFetch()
    const recorder = installWindowNetworkRecorder({ window, maxRequests: 1, maxBodyChars: 10 })
    const host = createWindowNetworkHost({ window, targetId: 'wide', maxRequests: 500, maxBodyChars: 65_536 })
    cleanup.push(() => recorder.dispose(), () => host.dispose())
    const active = await host.startCapture({ includeBuffered: false }, ctx('wide'))
    await window.fetch('/one'); await window.fetch('/two')
    await host.stopCapture({ captureId: active.captureId }, ctx('wide'))
    await expectOneOmitted(host, 'wide')
  })

  it('applies a recorder limit after an on-demand host installed the observer', async () => {
    installFetch()
    const host = createWindowNetworkHost({ window, targetId: 'wide', maxRequests: 500, maxBodyChars: 65_536 })
    cleanup.push(() => host.dispose())
    const active = await host.startCapture({ includeBuffered: false }, ctx('wide'))
    await window.fetch('/discarded-before-recorder')
    const recorder = installWindowNetworkRecorder({ window, maxRequests: 1, maxBodyChars: 10 })
    cleanup.push(() => recorder.dispose())
    await window.fetch('/one'); await window.fetch('/two')
    await host.stopCapture({ captureId: active.captureId }, ctx('wide'))
    await expectOneOmitted(host, 'wide')
  })

  it('does not let a later wide recorder enlarge a small recorder', async () => {
    installFetch()
    const small = installWindowNetworkRecorder({ window, maxRequests: 1, maxBodyChars: 10 })
    const wide = installWindowNetworkRecorder({ window, maxRequests: 500, maxBodyChars: 65_536 })
    const host = createWindowNetworkHost({ window, targetId: 'reader', maxBodyChars: 65_536 })
    cleanup.push(() => small.dispose(), () => wide.dispose(), () => host.dispose())
    await window.fetch('/one'); await window.fetch('/two')
    await expectOneOmitted(host, 'reader')
  })

  it('immediately constrains existing bodies when a smaller recorder joins', async () => {
    installFetch()
    const wide = installWindowNetworkRecorder({ window, maxRequests: 500, maxBodyChars: 65_536 })
    cleanup.push(() => wide.dispose())
    await window.fetch('/existing')
    const probe = createWindowNetworkHost({ window, targetId: 'probe' })
    cleanup.push(() => probe.dispose())
    await vi.waitFor(async () => {
      const { capture, requests } = await buffered(probe, 'probe')
      expect((await probe.getResponse({ captureId: capture.captureId, requestId: requests[0]!.requestId }, ctx('probe'))).body).toBeDefined()
    })
    probe.dispose()
    const small = installWindowNetworkRecorder({ window, maxRequests: 1, maxBodyChars: 10 })
    const host = createWindowNetworkHost({ window, targetId: 'reader', maxBodyChars: 65_536 })
    cleanup.push(() => small.dispose(), () => host.dispose())
    await expectOneOmitted(host, 'reader')
  })

  it('uses the tightened limit when a pending response body completes', async () => {
    const original = window.fetch
    let controller!: ReadableStreamDefaultController<Uint8Array>
    window.fetch = async () => new Response(new ReadableStream({ start(value) { controller = value } }), {
      headers: { 'content-type': 'application/json' },
    })
    cleanup.push(() => { window.fetch = original })
    const wide = installWindowNetworkRecorder({ window, maxBodyChars: 65_536 })
    cleanup.push(() => wide.dispose())
    await window.fetch('/pending')
    const small = installWindowNetworkRecorder({ window, maxBodyChars: 10 })
    const host = createWindowNetworkHost({ window, targetId: 'reader', maxBodyChars: 65_536 })
    cleanup.push(() => small.dispose(), () => host.dispose())
    controller.enqueue(new TextEncoder().encode('{"name":"a value longer than ten"}'))
    controller.close()
    await expectOneOmitted(host, 'reader')
  })
})
