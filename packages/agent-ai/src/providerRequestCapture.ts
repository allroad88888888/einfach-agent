// provider *.characterization.test.ts 共用的请求捕获与假响应构造。
// ---------------------------------------------------------------------------
// 只服务于跨 provider 的共形测试：不是任何 adapter 的实现代码，只是把「用一个假 fetchImpl
// 捕获 POST 出去的 URL/headers/body，再喂回一个可控响应」这段夹具逻辑收口成一个地方，
// 避免 providerTextRequest / providerRequestVendorDivergence 两份测试各自拷贝一份。

export function jsonResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

export function sseResponse(): Response {
  const source = [
    'data: {"choices":[{"delta":{"role":"assistant","content":"ok"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ].join('')
  const encoder = new TextEncoder()

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(source))
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

export function capture(response: () => Response): {
  fetchImpl: typeof fetch
  request(): { url: string; init: RequestInit }
} {
  let captured: { url: string; init: RequestInit } | undefined
  return {
    async fetchImpl(input, init) {
      captured = { url: String(input), init: init ?? {} }
      return response()
    },
    request() {
      if (!captured) throw new Error('Expected a captured model request.')
      return captured
    },
  }
}

export function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>
}
