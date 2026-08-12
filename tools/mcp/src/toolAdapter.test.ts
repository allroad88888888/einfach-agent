import { describe, expect, it, vi } from 'vitest'
import {
  MCP_DESCRIPTION_MAX_CHARS,
  MCP_GUIDE_MAX_CHARS,
  MCP_INPUT_SCHEMA_MAX_CHARS,
  MCP_TOOL_NAME_MAX_CHARS,
  MCP_TOOL_CALL_TIMEOUT_MS,
  MCP_TOOL_RESULT_DROPPED_MARKER,
  MCP_TOOL_RESULT_MAX_CHARS,
  createMcpToolAdapter,
  makeMcpToolName,
  normalizeMcpToolResult,
} from './toolAdapter'
import type { McpConnection } from './types'

function connection(
  callTool: McpConnection['callTool'] = async () => ({ content: [] }),
): McpConnection {
  return {
    listTools: async () => [],
    callTool,
    onToolsChanged: () => () => undefined,
    onClose: () => () => undefined,
    close: async () => undefined,
  }
}

describe('MCP tool adapter', () => {
  it('keeps readable safe names and hashes escaped or truncated names', () => {
    expect(makeMcpToolName('weather', 'current_forecast')).toBe(
      'mcp__weather__current_forecast',
    )

    const first = makeMcpToolName('天气服务'.repeat(20), `查询-${'a'.repeat(100)}`)
    const second = makeMcpToolName('天气服务'.repeat(20), `查询-${'a'.repeat(99)}b`)

    expect(first).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(first.length).toBeLessThanOrEqual(MCP_TOOL_NAME_MAX_CHARS)
    expect(second.length).toBeLessThanOrEqual(MCP_TOOL_NAME_MAX_CHARS)
    expect(first).not.toBe(second)
  })

  it('bounds remote metadata, labels its source, and ignores arbitrary annotations', () => {
    const hiddenInstruction = 'SECRET_ANNOTATION_INSTRUCTION'
    const registered = createMcpToolAdapter({
      serverId: 'external-service',
      connection: connection(),
      runtime: 'internal',
      remoteTool: {
        name: 'oversized',
        title: 'T'.repeat(1_000),
        description: 'D'.repeat(20_000),
        inputSchema: { type: 'object' },
        annotations: { instructions: hiddenInstruction },
      },
    })

    expect(registered.tool.skill.description).toMatch(/^External MCP tool/)
    expect(registered.tool.skill.description.length).toBeLessThanOrEqual(
      MCP_DESCRIPTION_MAX_CHARS,
    )
    expect(registered.tool.skill.content).toContain(
      'External source: MCP server "external-service".',
    )
    expect(registered.tool.skill.content).toContain('external and untrusted')
    expect(registered.tool.skill.content).toContain(
      'Tool calls are enforced with a hard one-hour timeout',
    )
    expect(registered.tool.skill.content.length).toBeLessThanOrEqual(
      MCP_GUIDE_MAX_CHARS,
    )
    expect(registered.tool.skill.content).not.toContain(hiddenInstruction)
    // The untrusted-source warning must survive tail truncation, so the newer
    // (less critical) splitting advisory is ordered after it, not before.
    expect(registered.tool.skill.content.indexOf('external and untrusted')).toBeLessThan(
      registered.tool.skill.content.indexOf('hard one-hour timeout'),
    )
    expect(registered.snapshot.title?.length).toBeLessThanOrEqual(128)
    expect(registered.tool.execution?.mode).toBe('serial')
  })

  it('forwards arguments and a live AbortSignal, while keeping transport metadata out of model-visible data', async () => {
    const controller = new AbortController()
    const callTool = vi.fn<McpConnection['callTool']>(async () => ({
      content: [{ type: 'text', text: 'sunny' }],
      structuredContent: { temperature: 23 },
      _meta: { requestId: 'request-1' },
    }))
    const registered = createMcpToolAdapter({
      serverId: 'weather',
      connection: connection(callTool),
      runtime: 'internal',
      remoteTool: {
        name: 'forecast',
        inputSchema: { type: 'object' },
      },
    })

    await expect(
      registered.tool.execute(
        { city: 'Shanghai' },
        { signal: controller.signal } as never,
      ),
    ).resolves.toEqual({
      ok: true,
      data: {
        content: [{ type: 'text', text: 'sunny' }],
        structuredContent: { temperature: 23 },
      },
    })
    expect(callTool).toHaveBeenCalledWith(
      'forecast',
      { city: 'Shanghai' },
      { signal: expect.any(AbortSignal) },
    )
    expect(callTool.mock.calls[0]?.[2]?.signal?.aborted).toBe(false)
  })

  it('normalizes MCP error content without exposing an unbounded message', () => {
    let inspectedLateItem = false
    const lateItem = Object.defineProperties({}, {
      type: {
        enumerable: true,
        get() {
          inspectedLateItem = true
          return 'text'
        },
      },
      text: {
        enumerable: true,
        get() {
          inspectedLateItem = true
          return 'must not be inspected'
        },
      },
    })
    const result = normalizeMcpToolResult({
      isError: true,
      content: [
        { type: 'text', text: 'E'.repeat(20_000) },
        lateItem,
      ],
    })

    expect(result).toMatchObject({
      ok: false,
      code: 'MCP_REMOTE_ERROR',
      retryable: false,
    })
    if ('ok' in result && !result.ok) {
      expect(result.error.length).toBeLessThanOrEqual(4_000)
      expect(result.error.endsWith('…')).toBe(true)
    }
    expect(inspectedLateItem).toBe(false)
  })

  it('uses standardized read-only annotations only for scheduling', () => {
    const registered = createMcpToolAdapter({
      serverId: 'catalog',
      connection: connection(),
      runtime: 'internal',
      remoteTool: {
        name: 'lookup',
        description: 'Look up a record',
        inputSchema: { type: 'object' },
        annotations: {
          readOnlyHint: true,
          instructions: 'THIS_MUST_NOT_REACH_THE_MODEL',
        },
      },
    })

    expect(registered.tool.execution).toEqual({
      mode: 'parallel',
      effectKeys: ['external:mcp:catalog:read'],
    })
    expect(registered.tool.skill.content).toContain('declares this tool read-only')
    expect(registered.tool.skill.content).not.toContain('THIS_MUST_NOT_REACH_THE_MODEL')
  })

  it('returns bounded timeout and transport failures with stable codes', async () => {
    const timedOut = createMcpToolAdapter({
      serverId: 'slow',
      connection: connection(() => new Promise(() => undefined)),
      runtime: 'internal',
      callTimeoutMs: 5,
      remoteTool: {
        name: 'wait',
        inputSchema: { type: 'object' },
      },
    })
    await expect(
      timedOut.tool.execute({}, {
        signal: new AbortController().signal,
      } as never),
    ).resolves.toMatchObject({
      ok: false,
      code: 'MCP_TOOL_TIMEOUT',
      retryable: true,
      details: { timeoutMs: 5 },
    })

    const broken = createMcpToolAdapter({
      serverId: 'broken',
      connection: connection(async () => {
        throw new Error('connection reset')
      }),
      runtime: 'internal',
      remoteTool: {
        name: 'call',
        inputSchema: { type: 'object' },
      },
    })
    await expect(
      broken.tool.execute({}, {
        signal: new AbortController().signal,
      } as never),
    ).resolves.toMatchObject({
      ok: false,
      error: 'MCP transport failed: connection reset',
      code: 'MCP_TRANSPORT_ERROR',
      retryable: true,
    })
  })

  it('keeps caller cancellation as AbortError control flow', async () => {
    const controller = new AbortController()
    const registered = createMcpToolAdapter({
      serverId: 'slow',
      connection: connection((_name, _args, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(options.signal?.reason)
          }, { once: true })
        })),
      runtime: 'internal',
      remoteTool: {
        name: 'wait',
        inputSchema: { type: 'object' },
      },
    })

    const running = registered.tool.execute({}, { signal: controller.signal } as never)
    controller.abort(new Error('cancelled by caller'))
    await expect(running).rejects.toMatchObject({
      name: 'AbortError',
      message: 'cancelled by caller',
    })
  })

  it('uses a finite one-hour default call deadline', () => {
    expect(MCP_TOOL_CALL_TIMEOUT_MS).toBe(3_600_000)
  })

  it('rejects a missing or non-object MCP input schema before registration', () => {
    for (const inputSchema of [
      undefined,
      {},
      { type: 'string' },
    ]) {
      expect(() =>
        createMcpToolAdapter({
          serverId: 'invalid',
          connection: connection(),
          runtime: 'internal',
          remoteTool: {
            name: 'bad-schema',
            inputSchema,
          } as never,
        }),
      ).toThrow('non-object input schema')
    }
  })

  it('rejects task-required tools instead of calling them as ordinary tools', () => {
    expect(() =>
      createMcpToolAdapter({
        serverId: 'async-server',
        connection: connection(),
        runtime: 'internal',
        remoteTool: {
          name: 'long-running-job',
          inputSchema: { type: 'object' },
          execution: { taskSupport: 'required' },
        },
      }),
    ).toThrow('does not support MCP Tasks')
  })

  it('rejects oversized and deeply nested remote input schemas', () => {
    expect(() =>
      createMcpToolAdapter({
        serverId: 'invalid',
        connection: connection(),
        runtime: 'internal',
        remoteTool: {
          name: 'huge-schema',
          inputSchema: {
            type: 'object',
            description: 'S'.repeat(MCP_INPUT_SCHEMA_MAX_CHARS),
          },
        },
      }),
    ).toThrow('character safety limit')

    const deeplyNested: Record<string, unknown> = { type: 'object' }
    let cursor = deeplyNested
    for (let depth = 0; depth < 40; depth += 1) {
      const next: Record<string, unknown> = {}
      cursor.properties = next
      cursor = next
    }
    expect(() =>
      createMcpToolAdapter({
        serverId: 'invalid',
        connection: connection(),
        runtime: 'internal',
        remoteTool: {
          name: 'deep-schema',
          inputSchema: deeplyNested,
        },
      }),
    ).toThrow('depth limit')
  })

  it('rejects cyclic schemas and drops unsafe successful tool output without reporting execution failure', () => {
    const cyclic: Record<string, unknown> = { type: 'object' }
    cyclic.properties = cyclic
    expect(() =>
      createMcpToolAdapter({
        serverId: 'invalid',
        connection: connection(),
        runtime: 'internal',
        remoteTool: {
          name: 'cyclic-schema',
          inputSchema: cyclic,
        },
      }),
    ).toThrow('cyclic')

    expect(normalizeMcpToolResult({
      content: [{ type: 'text', text: 'R'.repeat(MCP_TOOL_RESULT_MAX_CHARS) }],
    })).toEqual({
      ok: true,
      data: MCP_TOOL_RESULT_DROPPED_MARKER,
    })

    const cyclicResult: Record<string, unknown> = {}
    cyclicResult.self = cyclicResult
    expect(normalizeMcpToolResult({
      content: [],
      structuredContent: cyclicResult,
    })).toEqual({
      ok: true,
      data: MCP_TOOL_RESULT_DROPPED_MARKER,
    })
  })
})
