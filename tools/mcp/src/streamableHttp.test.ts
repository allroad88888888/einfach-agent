import { beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  connect: vi.fn(),
  close: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  setNotificationHandler: vi.fn(),
  removeNotificationHandler: vi.fn(),
  transport: vi.fn(),
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    onerror: ((error: Error) => void) | undefined
    onclose: (() => void) | undefined

    connect(...args: unknown[]) {
      return sdk.connect(...args)
    }

    close(...args: unknown[]) {
      return sdk.close(...args)
    }

    listTools(...args: unknown[]) {
      return sdk.listTools(...args)
    }

    callTool(...args: unknown[]) {
      return sdk.callTool(...args)
    }

    setNotificationHandler(...args: unknown[]) {
      return sdk.setNotificationHandler(...args)
    }

    removeNotificationHandler(...args: unknown[]) {
      return sdk.removeNotificationHandler(...args)
    }
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor(...args: unknown[]) {
      sdk.transport(...args)
    }
  },
}))

vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  ToolListChangedNotificationSchema: {},
}))

import {
  MCP_SERVER_MAX_TOOLS,
  MCP_TOOLS_LIST_MAX_PAGES,
} from './internal'
import {
  MCP_STREAMABLE_HTTP_MAX_RESPONSE_BYTES,
  createStreamableHttpMcpConnector,
} from './streamableHttp'

const CONFIG = {
  id: 'bounded',
  transport: 'streamable-http',
  url: 'https://mcp.example.test',
} as const

type TransportFetch = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>

function getTransportFetch(): TransportFetch {
  const options = sdk.transport.mock.calls.at(-1)?.[1] as
    | { fetch?: TransportFetch }
    | undefined
  if (!options?.fetch) {
    throw new Error('Expected the connector to provide a guarded fetch')
  }
  return options.fetch
}

function createChunkedResponse(
  chunks: readonly Uint8Array[],
  contentType: string,
  onCancel: (reason?: unknown) => void = () => undefined,
): Response {
  let sentChunks = 0
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[sentChunks]
        if (!chunk) {
          controller.close()
          return
        }
        sentChunks += 1
        controller.enqueue(chunk)
      },
      cancel(reason) {
        onCancel(reason)
      },
    }),
    { headers: { 'content-type': contentType } },
  )
}

describe('Streamable HTTP tools/list limits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sdk.connect.mockResolvedValue(undefined)
    sdk.close.mockResolvedValue(undefined)
  })

  it('stops cursor pagination at the maximum page count', async () => {
    let page = 0
    sdk.listTools.mockImplementation(async () => {
      page += 1
      return { tools: [], nextCursor: `cursor-${page}` }
    })
    const connection = await createStreamableHttpMcpConnector().connect(CONFIG)

    await expect(connection.listTools()).rejects.toThrow(
      `exceeded ${MCP_TOOLS_LIST_MAX_PAGES} pages`,
    )
    expect(sdk.listTools).toHaveBeenCalledTimes(MCP_TOOLS_LIST_MAX_PAGES)
  })

  it('rejects a response that exceeds the cumulative tool limit', async () => {
    sdk.listTools.mockResolvedValue({
      tools: Array.from({ length: MCP_SERVER_MAX_TOOLS + 1 }, (_, index) => ({
        name: `tool-${index}`,
        inputSchema: { type: 'object' },
      })),
    })
    const connection = await createStreamableHttpMcpConnector().connect(CONFIG)

    await expect(connection.listTools()).rejects.toThrow(
      `exceeded ${MCP_SERVER_MAX_TOOLS} tools`,
    )
    expect(sdk.listTools).toHaveBeenCalledTimes(1)
  })
})

describe('Streamable HTTP response byte limits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sdk.connect.mockResolvedValue(undefined)
    sdk.close.mockResolvedValue(undefined)
  })

  it('rejects chunked JSON before the SDK can parse an oversized body', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x20)
    const chunks = Array.from(
      {
        length:
          Math.floor(
            MCP_STREAMABLE_HTTP_MAX_RESPONSE_BYTES / chunk.byteLength,
          ) + 10,
      },
      () => chunk,
    )
    const response = createChunkedResponse(chunks, 'application/json')
    const fetch = vi.fn().mockResolvedValue(response)
    await createStreamableHttpMcpConnector({ fetch }).connect(CONFIG)

    const guardedResponse = await getTransportFetch()(CONFIG.url)

    await expect(guardedResponse.json()).rejects.toThrow(
      `response exceeded ${MCP_STREAMABLE_HTTP_MAX_RESPONSE_BYTES} bytes`,
    )
  })

  it('rejects one oversized SSE event split across chunks', async () => {
    const firstChunk = new TextEncoder().encode(
      `data: ${'x'.repeat(1024 * 1024)}`,
    )
    const continuationChunk = new Uint8Array(1024 * 1024).fill(0x78)
    const chunks = [
      firstChunk,
      continuationChunk,
      continuationChunk,
      continuationChunk,
      continuationChunk,
      continuationChunk,
    ]
    const response = createChunkedResponse(
      chunks,
      'text/event-stream; charset=utf-8',
    )
    const fetch = vi.fn().mockResolvedValue(response)
    await createStreamableHttpMcpConnector({ fetch }).connect(CONFIG)

    const guardedResponse = await getTransportFetch()(CONFIG.url)

    await expect(guardedResponse.text()).rejects.toThrow(
      `SSE event exceeded ${MCP_STREAMABLE_HTTP_MAX_RESPONSE_BYTES} bytes`,
    )
  })

  it('allows many bounded SSE events whose total exceeds the response limit', async () => {
    const payload = 'x'.repeat(64 * 1024)
    const encoder = new TextEncoder()
    const eventChunks = [
      encoder.encode(`data: ${payload}\n\n`),
      encoder.encode(`data: ${payload}\r\n\r\n`),
      encoder.encode(`data: ${payload}\r\r`),
    ]
    const chunks = Array.from(
      { length: 24 },
      () => eventChunks,
    ).flat()
    const totalBytes = chunks.reduce(
      (total, chunk) => total + chunk.byteLength,
      0,
    )
    expect(totalBytes).toBeGreaterThan(MCP_STREAMABLE_HTTP_MAX_RESPONSE_BYTES)
    const response = createChunkedResponse(chunks, 'text/event-stream')
    const fetch = vi.fn().mockResolvedValue(response)
    await createStreamableHttpMcpConnector({ fetch }).connect(CONFIG)

    const guardedResponse = await getTransportFetch()(CONFIG.url)

    const body = await guardedResponse.arrayBuffer()
    expect(body.byteLength).toBe(totalBytes)
  })

  it('rejects an oversized declared non-SSE body before reading it', async () => {
    const onCancel = vi.fn()
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array([0x7b, 0x7d]))
        },
        cancel(reason) {
          onCancel(reason)
        },
      }),
      {
        headers: {
          'content-length': String(
            MCP_STREAMABLE_HTTP_MAX_RESPONSE_BYTES + 1,
          ),
          'content-type': 'application/json',
        },
      },
    )
    const fetch = vi.fn().mockResolvedValue(response)
    await createStreamableHttpMcpConnector({ fetch }).connect(CONFIG)

    await expect(getTransportFetch()(CONFIG.url)).rejects.toThrow(
      `response exceeded ${MCP_STREAMABLE_HTTP_MAX_RESPONSE_BYTES} bytes`,
    )
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
