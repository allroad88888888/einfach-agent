import { afterEach, describe, expect, it } from 'vitest'
import { createWindowNetworkHost } from './window-host'

class FakeXhr extends EventTarget {
  responseType: XMLHttpRequestResponseType = ''
  response: unknown = null
  responseText = ''
  status = 200
  private headers = new Headers({ 'content-type': 'application/json' })

  open(_method: string, _url: string | URL, _async = true): void {}
  setRequestHeader(_name: string, _value: string): void {}
  send(_body?: Document | XMLHttpRequestBodyInit | null): void {
    this.dispatchEvent(new Event('load'))
  }
  abort(): void { this.dispatchEvent(new Event('abort')) }
  getResponseHeader(name: string): string | null { return this.headers.get(name) }
  getAllResponseHeaders(): string { return 'content-type: application/json\r\nset-cookie: hidden' }
}

const originalDescriptor = Object.getOwnPropertyDescriptor(window, 'XMLHttpRequest')
const hosts: Array<{ dispose(): void }> = []
afterEach(() => {
  while (hosts.length) hosts.pop()!.dispose()
  if (originalDescriptor) Object.defineProperty(window, 'XMLHttpRequest', originalDescriptor)
})

describe('XMLHttpRequest observation', () => {
  it('captures and recursively redacts responseType json', async () => {
    Object.defineProperty(window, 'XMLHttpRequest', { configurable: true, writable: true, value: FakeXhr })
    const host = createWindowNetworkHost({ window, targetId: 'target' })
    hosts.push(host)
    const context = { sessionId: 'session', signal: new AbortController().signal }
    const capture = await host.startCapture({}, context)
    const xhr = new window.XMLHttpRequest() as unknown as FakeXhr
    xhr.responseType = 'json'
    xhr.response = { nested: { refreshToken: 'hidden', name: 'safe' } }
    xhr.open('POST', '/xhr')
    xhr.setRequestHeader('authorization', 'hidden')
    xhr.setRequestHeader('content-type', 'application/json')
    xhr.send('{"client_secret":"hidden","name":"safe"}')
    const listed = await host.listRequests({ captureId: capture.captureId }, context)
    const requestId = listed.requests[0]!.requestId
    expect(await host.getRequest({ captureId: capture.captureId, requestId }, context)).toMatchObject({
      state: 'complete',
      requestHeaders: { 'content-type': 'application/json' },
      requestBody: '{"client_secret":"[REDACTED]","name":"safe"}',
    })
    expect(await host.getResponse({ captureId: capture.captureId, requestId }, context)).toMatchObject({
      body: '{"nested":{"refreshToken":"[REDACTED]","name":"safe"}}',
      headers: { 'content-type': 'application/json' },
    })
  })

  it('records abort as a fixed error without changing abort behavior', async () => {
    class AbortXhr extends FakeXhr {
      override send(): void { this.dispatchEvent(new Event('abort')) }
    }
    Object.defineProperty(window, 'XMLHttpRequest', { configurable: true, writable: true, value: AbortXhr })
    const host = createWindowNetworkHost({ window, targetId: 'target' })
    hosts.push(host)
    const context = { sessionId: 'session', signal: new AbortController().signal }
    const capture = await host.startCapture({}, context)
    const xhr = new window.XMLHttpRequest() as unknown as FakeXhr
    xhr.open('GET', '/abort')
    xhr.send()
    expect((await host.listRequests({ captureId: capture.captureId }, context)).requests[0]).toMatchObject({ state: 'error' })
  })
})
