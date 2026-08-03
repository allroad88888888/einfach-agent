import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

const MODEL_PREVIEW_RELAY_PATH = '/__web_agent_model_preview'
const MAX_MODEL_REQUEST_BYTES = 4 * 1024 * 1024

type ModelPreviewProvider = 'deepseek' | 'glm'
type RelayNext = (error?: unknown) => void

type ModelPreviewRelayCredentials = Partial<Record<ModelPreviewProvider, string | undefined>>
type ModelPreviewFetch = (input: string, init: RequestInit) => Promise<Response>

const modelProviderUrls: Readonly<Record<ModelPreviewProvider, string>> = {
  deepseek: 'https://api.deepseek.com/chat/completions',
  glm: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
}

class RelayRequestError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message)
  }
}

function providerForRequest(url: string | undefined): ModelPreviewProvider | undefined {
  const parsed = new URL(url ?? '/', 'http://localhost')
  if (parsed.search) return undefined
  const { pathname } = parsed
  return (Object.keys(modelProviderUrls) as ModelPreviewProvider[]).find(
    (provider) => pathname === `${MODEL_PREVIEW_RELAY_PATH}/${provider}`,
  )
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function requireJsonContent(request: IncomingMessage): void {
  const contentType = request.headers['content-type']
  if (typeof contentType === 'string' && contentType.toLowerCase().startsWith('application/json')) return
  throw new RelayRequestError(415, '模型开发中继只接受 JSON 请求。')
}

async function readRequestBody(request: IncomingMessage): Promise<Uint8Array> {
  const declaredLength = Number(request.headers['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MODEL_REQUEST_BYTES) {
    throw new RelayRequestError(413, '模型请求超过本地开发中继大小限制。')
  }

  const chunks: Buffer[] = []
  let totalLength = 0
  for await (const value of request) {
    const chunk = Buffer.from(value)
    totalLength += chunk.length
    if (totalLength > MAX_MODEL_REQUEST_BYTES) {
      throw new RelayRequestError(413, '模型请求超过本地开发中继大小限制。')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function writeError(response: ServerResponse, statusCode: number, message: string): void {
  if (response.destroyed || response.writableEnded) return
  response.statusCode = statusCode
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-type', 'text/plain; charset=utf-8')
  response.end(message)
}

function copyUpstreamHeaders(upstream: Response, response: ServerResponse): void {
  const contentType = upstream.headers.get('content-type')
  const retryAfter = upstream.headers.get('retry-after')
  response.statusCode = upstream.status
  response.setHeader('cache-control', 'no-store')
  if (contentType) response.setHeader('content-type', contentType)
  if (retryAfter) response.setHeader('retry-after', retryAfter)
}

async function streamUpstreamResponse(upstream: Response, response: ServerResponse): Promise<void> {
  copyUpstreamHeaders(upstream, response)
  if (!upstream.body) {
    response.end()
    return
  }

  const reader = upstream.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    response.write(value)
  }
  response.end()
}

function relayCredential(
  credentials: ModelPreviewRelayCredentials,
  provider: ModelPreviewProvider,
): string {
  const credential = credentials[provider]?.trim()
  if (credential) return credential
  throw new RelayRequestError(503, '本地开发预览尚未配置该模型凭据。')
}

async function relayModelRequest(
  request: IncomingMessage,
  response: ServerResponse,
  provider: ModelPreviewProvider,
  credentials: ModelPreviewRelayCredentials,
  fetchImpl: ModelPreviewFetch,
): Promise<void> {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    throw new RelayRequestError(403, '模型开发中继仅接受本机请求。')
  }
  if (request.method !== 'POST') {
    throw new RelayRequestError(405, '模型开发中继只接受 POST 请求。')
  }
  requireJsonContent(request)

  const apiKey = relayCredential(credentials, provider)
  const abortController = new AbortController()
  const cancelUpstream = () => abortController.abort()
  request.once('aborted', cancelUpstream)
  response.once('close', cancelUpstream)
  try {
    const upstream = await fetchImpl(modelProviderUrls[provider], {
      method: 'POST',
      redirect: 'error',
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: await readRequestBody(request),
      signal: abortController.signal,
    })
    await streamUpstreamResponse(upstream, response)
  } finally {
    request.removeListener('aborted', cancelUpstream)
    response.removeListener('close', cancelUpstream)
  }
}

export function createModelPreviewRelayHandler(options: {
  credentials: ModelPreviewRelayCredentials
  fetchImpl?: ModelPreviewFetch
}): (request: IncomingMessage, response: ServerResponse, next: RelayNext) => void {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  return (request, response, next) => {
    const provider = providerForRequest(request.url)
    if (!provider) {
      next()
      return
    }
    void relayModelRequest(request, response, provider, options.credentials, fetchImpl).catch((error) => {
      if (response.destroyed || response.writableEnded) return
      if (error instanceof RelayRequestError) {
        writeError(response, error.statusCode, error.message)
        return
      }
      writeError(response, 502, '模型开发中继请求失败。')
    })
  }
}

/** Installs the fixed, loopback-only model relay used by `pnpm dev`. */
export function createModelPreviewRelayPlugin(credentials: ModelPreviewRelayCredentials): Plugin {
  return {
    name: 'web-agent-model-preview-relay',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(createModelPreviewRelayHandler({ credentials }))
    },
  }
}
