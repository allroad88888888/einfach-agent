import { Channel, invoke } from '@tauri-apps/api/core'
import type {
  ProviderTransport,
  ProviderTransportInput,
  ProviderWireRequest,
} from '@web-agent/ai'
import { createProviderFetch } from './providerFetch'
import { encodeProviderWireRequest } from './providerWireEnvelope'

type ModelProxyEvent =
  | { type: 'started' }
  | { type: 'response'; status: number; contentType?: string; retryAfter?: string }
  | { type: 'chunk'; bytes: number[] }
  | { type: 'end' }
  | { type: 'error'; message: string }

function abortedError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

function responseHeaders(event: Extract<ModelProxyEvent, { type: 'response' }>): Headers {
  const headers = new Headers()
  if (event.contentType) headers.set('content-type', event.contentType)
  if (event.retryAfter) headers.set('retry-after', event.retryAfter)
  return headers
}

function invokeProviderRequest(
  request: ProviderWireRequest,
  signal?: AbortSignal,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let responseResolved = false
    let finished = false
    let abortRequested = false
    let nativeStarted = false
    let cancelSent = false
    let hasResponseBody = true
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const { requestId } = request
    const cancelNativeRequest = () => {
      if (!nativeStarted || cancelSent) return
      cancelSent = true
      void invoke<boolean>('cancel_model_provider_request', { requestId }).catch(() => {})
    }
    const fail = (error: Error) => {
      if (finished) return
      finished = true
      signal?.removeEventListener('abort', onAbort)
      if (responseResolved && hasResponseBody) controller?.error(error)
      else if (!responseResolved) reject(error)
    }
    const onAbort = () => {
      abortRequested = true
      cancelNativeRequest()
      fail(abortedError())
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const stream = new ReadableStream<Uint8Array>({
      start(nextController) {
        controller = nextController
      },
    })
    const events = new Channel<ModelProxyEvent>((event) => {
      if (event.type === 'started') {
        nativeStarted = true
        if (abortRequested) cancelNativeRequest()
        return
      }
      if (finished) return
      if (event.type === 'response') {
        responseResolved = true
        hasResponseBody = event.status !== 204 && event.status !== 205
        resolve(new Response(hasResponseBody ? stream : null, {
          status: event.status,
          headers: responseHeaders(event),
        }))
        return
      }
      if (event.type === 'chunk') {
        if (hasResponseBody) controller?.enqueue(Uint8Array.from(event.bytes))
        return
      }
      if (event.type === 'end') {
        finished = true
        signal?.removeEventListener('abort', onAbort)
        if (hasResponseBody) controller?.close()
        if (!responseResolved) reject(new Error('模型响应格式无效'))
        return
      }
      fail(new Error(event.message))
    })
    void invoke<void>('model_provider_request', { input: request, events }).catch((error) => {
      fail(error instanceof Error ? error : new Error('模型代理请求失败'))
    })
  })
}

/** Creates the typed desktop transport backed by the restricted Rust gateway. */
export function createTauriProviderTransport(): ProviderTransport {
  return {
    async request(input: ProviderTransportInput): Promise<Response> {
      const request = await encodeProviderWireRequest(input)
      return invokeProviderRequest(request, input.signal)
    },
  }
}

/** Preserves the existing fetch injection API for all current model adapters. */
export function createTauriModelFetch(): typeof fetch {
  return createProviderFetch(createTauriProviderTransport())
}
