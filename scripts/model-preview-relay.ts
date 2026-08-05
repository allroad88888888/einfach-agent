import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { PROVIDER_TRANSPORT_LIMITS as LIMITS } from '../packages/agent-ai/src/providerTransport'
import { parseRelayEnvelope, type RelayUpstreamRequest } from './model-preview-relay-body'
import { RelayRequestError } from './model-preview-relay-error'
import {
  modelPreviewCredential,
  type ModelPreviewRelayCredentials,
} from './model-preview-relay-routes'

const MODEL_PREVIEW_RELAY_PATH = '/__web_agent_model_preview'
type RelayNext = (error?: unknown) => void
type ModelPreviewFetch = (input: string, init: RequestInit) => Promise<Response>

function isRelayRequest(url: string | undefined): boolean {
  const parsed = new URL(url ?? '/', 'http://localhost')
  return !parsed.search && parsed.pathname === MODEL_PREVIEW_RELAY_PATH
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
  if (Number.isFinite(declaredLength) && declaredLength > LIMITS.maxWireRequestBytes) {
    throw new RelayRequestError(413, '模型请求超过本地开发中继大小限制。')
  }
  const chunks: Buffer[] = []
  let totalLength = 0
  for await (const value of request) {
    const chunk = Buffer.from(value)
    totalLength += chunk.length
    if (totalLength > LIMITS.maxWireRequestBytes) {
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

function declaredResponseLength(upstream: Response): number | undefined {
  const header = upstream.headers.get('content-length')
  if (header === null) return undefined
  const value = Number(header)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

async function writeChunk(response: ServerResponse, chunk: Uint8Array): Promise<void> {
  if (response.write(chunk)) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.removeListener('drain', onDrain)
      response.removeListener('close', onClose)
    }
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onClose = () => {
      cleanup()
      reject(new Error('模型开发中继响应已关闭。'))
    }
    response.once('drain', onDrain)
    response.once('close', onClose)
  })
}

async function streamUpstreamResponse(
  upstream: Response,
  response: ServerResponse,
  maxBytes: number,
): Promise<void> {
  const declared = declaredResponseLength(upstream)
  if (declared !== undefined && declared > maxBytes) {
    await upstream.body?.cancel()
    throw new RelayRequestError(502, '模型服务响应超过大小限制。')
  }
  copyUpstreamHeaders(upstream, response)
  if (!upstream.body) {
    response.end()
    return
  }
  const reader = upstream.body.getReader()
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      response.destroy()
      return
    }
    await writeChunk(response, value)
  }
  response.end()
}

function upstreamHeaders(request: RelayUpstreamRequest, apiKey: string): Headers {
  const headers = new Headers({
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${apiKey}`,
  })
  if (request.contentType) headers.set('content-type', request.contentType)
  return headers
}

async function relayModelRequest(
  request: IncomingMessage,
  response: ServerResponse,
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
  const upstreamRequest = parseRelayEnvelope(await readRequestBody(request))
  const apiKey = modelPreviewCredential(credentials, upstreamRequest.route)
  const abortController = new AbortController()
  let timedOut = false
  const cancelUpstream = () => abortController.abort()
  const timeout = setTimeout(() => {
    timedOut = true
    abortController.abort()
  }, LIMITS.requestTimeoutMs)
  request.once('aborted', cancelUpstream)
  response.once('close', cancelUpstream)
  try {
    const upstream = await fetchImpl(upstreamRequest.route.url, {
      method: upstreamRequest.route.target.method,
      redirect: 'error',
      headers: upstreamHeaders(upstreamRequest, apiKey),
      body: upstreamRequest.body,
      signal: abortController.signal,
    })
    await streamUpstreamResponse(upstream, response, upstreamRequest.route.maxResponseBytes)
  } catch (error) {
    if (timedOut) throw new RelayRequestError(504, '模型开发中继请求超时。')
    throw error
  } finally {
    clearTimeout(timeout)
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
    if (!isRelayRequest(request.url)) {
      next()
      return
    }
    void relayModelRequest(request, response, options.credentials, fetchImpl).catch((error) => {
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
