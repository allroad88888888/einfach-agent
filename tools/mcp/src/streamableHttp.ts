import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  MCP_SERVER_MAX_TOOLS,
  MCP_TOOLS_LIST_MAX_PAGES,
  raceWithAbort,
  throwIfAborted,
  toError,
} from './internal'
import type {
  McpCallToolResult,
  McpConnection,
  McpConnectionCloseListener,
  McpConnector,
  McpOperationOptions,
  McpRemoteTool,
  McpServerConfig,
  McpStreamableHttpServerConfig,
  McpToolsChangedListener,
} from './types'

export const MCP_STREAMABLE_HTTP_MAX_RESPONSE_BYTES = 4 * 1024 * 1024

export interface StreamableHttpMcpConnectorOptions {
  clientInfo?: {
    name: string
    version: string
  }
  fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>
}

function responseTooLargeError(kind: 'response' | 'SSE event'): Error {
  return new Error(
    `MCP Streamable HTTP ${kind} exceeded ${MCP_STREAMABLE_HTTP_MAX_RESPONSE_BYTES} bytes`,
  )
}

function isEventStream(response: Response): boolean {
  return response.headers
    .get('content-type')
    ?.split(';', 1)[0]
    ?.trim()
    .toLowerCase() === 'text/event-stream'
}

function declaredResponseSize(response: Response): bigint | undefined {
  const rawLength = response.headers.get('content-length')?.trim()
  if (!rawLength || !/^\d+$/.test(rawLength)) return undefined

  try {
    return BigInt(rawLength)
  } catch {
    return undefined
  }
}

function boundedResponseBody(
  body: ReadableStream<Uint8Array>,
  eventStream: boolean,
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let receivedBytes = 0
  let eventBytes = 0
  let lineHasData = false
  let previousByteWasCr = false
  let previousCrEndedEmptyLine = false
  let finished = false

  const releaseReader = () => {
    try {
      reader.releaseLock()
    } catch {
      // A pending read owns the lock until it settles.
    }
  }

  const validateChunk = (chunk: Uint8Array) => {
    if (!eventStream) {
      receivedBytes += chunk.byteLength
      if (receivedBytes > MCP_STREAMABLE_HTTP_MAX_RESPONSE_BYTES) {
        throw responseTooLargeError('response')
      }
      return
    }

    for (const byte of chunk) {
      eventBytes += 1

      if (byte === 0x0a && previousByteWasCr) {
        if (previousCrEndedEmptyLine) eventBytes = 0
        previousByteWasCr = false
        previousCrEndedEmptyLine = false
      } else if (byte === 0x0d || byte === 0x0a) {
        const emptyLine = !lineHasData
        lineHasData = false
        previousByteWasCr = byte === 0x0d
        previousCrEndedEmptyLine = previousByteWasCr && emptyLine
        if (emptyLine) eventBytes = 0
      } else {
        lineHasData = true
        previousByteWasCr = false
        previousCrEndedEmptyLine = false
      }

      if (eventBytes > MCP_STREAMABLE_HTTP_MAX_RESPONSE_BYTES) {
        throw responseTooLargeError('SSE event')
      }
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          finished = true
          releaseReader()
          controller.close()
          return
        }

        validateChunk(value)
        controller.enqueue(value)
      } catch (error) {
        finished = true
        controller.error(error)
        void reader
          .cancel(error)
          .catch(() => undefined)
          .finally(releaseReader)
      }
    },
    async cancel(reason) {
      if (finished) return
      finished = true
      try {
        await reader.cancel(reason)
      } finally {
        releaseReader()
      }
    },
  })
}

async function boundFetchResponse(
  fetchResponse: Promise<Response>,
): Promise<Response> {
  const response = await fetchResponse
  const eventStream = isEventStream(response)
  const declaredSize = declaredResponseSize(response)
  if (
    !eventStream
    && declaredSize !== undefined
    && declaredSize > BigInt(MCP_STREAMABLE_HTTP_MAX_RESPONSE_BYTES)
  ) {
    const error = responseTooLargeError('response')
    await response.body?.cancel(error).catch(() => undefined)
    throw error
  }

  if (!response.body) return response

  return new Response(boundedResponseBody(response.body, eventStream), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

class SdkStreamableHttpConnection implements McpConnection {
  private readonly toolsChangedListeners = new Set<McpToolsChangedListener>()
  private readonly closeListeners = new Set<McpConnectionCloseListener>()
  private lastError: Error | undefined
  private closed = false

  constructor(private readonly client: Client) {
    client.onerror = (error) => {
      this.lastError = error
    }
    client.onclose = () => {
      for (const listener of [...this.closeListeners]) {
        listener(this.lastError)
      }
    }
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      await Promise.allSettled([...this.toolsChangedListeners].map((listener) => listener()))
    })
  }

  async listTools(options?: McpOperationOptions): Promise<readonly McpRemoteTool[]> {
    const tools: McpRemoteTool[] = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    let pageCount = 0

    do {
      throwIfAborted(options?.signal)
      if (pageCount >= MCP_TOOLS_LIST_MAX_PAGES) {
        throw new Error(
          `MCP tools/list exceeded ${MCP_TOOLS_LIST_MAX_PAGES} pages`,
        )
      }
      pageCount += 1
      const page = await this.client.listTools(
        cursor === undefined ? undefined : { cursor },
        { signal: options?.signal },
      )
      if (tools.length + page.tools.length > MCP_SERVER_MAX_TOOLS) {
        throw new Error(
          `MCP tools/list exceeded ${MCP_SERVER_MAX_TOOLS} tools`,
        )
      }
      tools.push(
        ...page.tools.map((tool) => ({
          ...tool,
          inputSchema: tool.inputSchema as Record<string, unknown>,
          annotations: tool.annotations as Record<string, unknown> | undefined,
        })),
      )
      cursor = page.nextCursor
      if (cursor && seenCursors.has(cursor)) {
        throw new Error(`MCP tools/list repeated cursor: ${cursor}`)
      }
      if (cursor) seenCursors.add(cursor)
    } while (cursor)

    return tools
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: McpOperationOptions,
  ): Promise<McpCallToolResult> {
    throwIfAborted(options?.signal)
    return this.client.callTool(
      { name, arguments: args },
      undefined,
      { signal: options?.signal },
    ) as Promise<McpCallToolResult>
  }

  /**
   * MCP 协议自带的 ping：请求体只有 method，响应是空对象。保活探测用它而不是 listTools，
   * 见 types.ts 的 McpConnection.ping。超时由调用方经 signal 控制（SDK 自己的默认请求
   * 超时是最后一道兜底，比保活探测的超时长得多）。
   */
  async ping(options?: McpOperationOptions): Promise<void> {
    throwIfAborted(options?.signal)
    await this.client.ping({ signal: options?.signal })
  }

  onToolsChanged(listener: McpToolsChangedListener): () => void {
    this.toolsChangedListeners.add(listener)
    return () => this.toolsChangedListeners.delete(listener)
  }

  onClose(listener: McpConnectionCloseListener): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.client.removeNotificationHandler('notifications/tools/list_changed')
    await this.client.close()
  }
}

/** Official SDK 1.x Streamable HTTP connector. */
export class StreamableHttpMcpConnector implements McpConnector {
  private readonly clientInfo: { name: string; version: string }
  private readonly fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>

  constructor(options: StreamableHttpMcpConnectorOptions = {}) {
    this.clientInfo = options.clientInfo ?? {
      name: 'web-agent',
      version: '0.1.0',
    }
    this.fetch = options.fetch
  }

  async connect(
    config: McpServerConfig,
    options?: McpOperationOptions,
  ): Promise<McpConnection> {
    if (config.transport !== 'streamable-http') {
      throw new Error(
        `StreamableHttpMcpConnector cannot connect transport: ${config.transport}`,
      )
    }
    return this.connectHttp(config, options)
  }

  private async connectHttp(
    config: McpStreamableHttpServerConfig,
    options?: McpOperationOptions,
  ): Promise<McpConnection> {
    throwIfAborted(options?.signal)
    const customFetch = this.fetch
    const guardedFetch = (url: string | URL, init?: RequestInit) =>
      boundFetchResponse(
        customFetch
          ? customFetch(url, init)
          : globalThis.fetch(url, init),
      )
    const client = new Client(this.clientInfo, { capabilities: {} })
    const connection = new SdkStreamableHttpConnection(client)
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.headers ? { headers: { ...config.headers } } : undefined,
      fetch: guardedFetch,
    })

    try {
      await raceWithAbort(client.connect(transport), options?.signal)
      return connection
    } catch (error) {
      await connection.close().catch(() => undefined)
      throw toError(error)
    }
  }
}

export function createStreamableHttpMcpConnector(
  options?: StreamableHttpMcpConnectorOptions,
): McpConnector {
  return new StreamableHttpMcpConnector(options)
}
