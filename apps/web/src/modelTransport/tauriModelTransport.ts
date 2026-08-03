import { Channel, invoke } from '@tauri-apps/api/core'
import { modelProviderForChatRequest, type ModelProvider } from './modelEndpoint'

type ModelProxyEvent =
  | { type: 'response'; status: number; contentType?: string }
  | { type: 'chunk'; bytes: number[] }
  | { type: 'end' }
  | { type: 'error'; message: string }

type ModelProxyInput = {
  provider: ModelProvider
  body: string
}

function abortedError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

function requestBody(init?: RequestInit): string {
  if (typeof init?.body !== 'string') throw new Error('模型请求格式无效')
  return init.body
}

/** Rebuilds a streaming fetch Response from the desktop process's restricted model gateway. */
export function createTauriModelFetch(): typeof fetch {
  return (input, init) => new Promise<Response>((resolve, reject) => {
    let started = false
    let finished = false
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const signal = init?.signal
    const fail = (error: Error) => {
      if (finished) return
      finished = true
      signal?.removeEventListener('abort', onAbort)
      if (started) controller?.error(error)
      else reject(error)
    }
    const onAbort = () => fail(abortedError())
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
