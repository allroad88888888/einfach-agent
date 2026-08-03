import { Channel, invoke } from '@tauri-apps/api/core'
import { modelProviderForChatRequest, type ModelProvider } from './modelEndpoint'

type ModelProxyEvent =
  | { type: 'started' }
  | { type: 'response'; status: number; contentType?: string }
  | { type: 'chunk'; bytes: number[] }
  | { type: 'end' }
  | { type: 'error'; message: string }

type ModelProxyInput = {
  provider: ModelProvider
  body: string
  requestId: string
}

let fallbackRequestSequence = 0

function abortedError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

function requestBody(init?: RequestInit): string {
  if (typeof init?.body !== 'string') throw new Error('模型请求格式无效')
  return init.body
}

function createRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid
  fallbackRequestSequence += 1
  return `model-${Date.now().toString(36)}-${fallbackRequestSequence.toString(36)}-${Math.random().toString(36).slice(2)}`
}

/** Rebuilds a streaming fetch Response from the desktop process's restricted model gateway. */
export function createTauriModelFetch(): typeof fetch {
  return (input, init) => new Promise<Response>((resolve, reject) => {
    let started = false
    let finished = false
    let abortRequested = false
    let nativeStarted = false
    let cancelSent = false
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const signal = init?.signal
    const fail = (error: Error) => {
      if (finished) return
      finished = true
      signal?.removeEventListener('abort', onAbort)
      if (started) controller?.error(error)
      else reject(error)
    }
    const requestId = createRequestId()
    const cancelNativeRequest = () => {
      if (!nativeStarted || cancelSent) return
      cancelSent = true
      void invoke<boolean>('cancel_model_chat_completions', { requestId }).catch(() => {})
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

    let proxyInput: ModelProxyInput
    try {
      proxyInput = {
        provider: modelProviderForChatRequest(input),
        body: requestBody(init),
        requestId,
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error('模型请求格式无效'))
      return
    }

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
        started = true
        const headers = new Headers()
        if (event.contentType) headers.set('content-type', event.contentType)
        resolve(new Response(stream, { status: event.status, headers }))
        return
      }
      if (event.type === 'chunk') {
        controller?.enqueue(Uint8Array.from(event.bytes))
        return
      }
      if (event.type === 'end') {
        finished = true
        signal?.removeEventListener('abort', onAbort)
        controller?.close()
        return
      }
      fail(new Error(event.message))
    })
    void invoke<void>('model_chat_completions', { input: proxyInput, events }).catch((error) => {
      fail(error instanceof Error ? error : new Error('模型代理请求失败'))
    })
  })
}
