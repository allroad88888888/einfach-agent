import { createToolRegistry } from '@einfach-agent/core/tools'
import type { Tool, ToolContext } from '@einfach-agent/core/tools'
import { describe, expect, it, vi } from 'vitest'
import { McpClientManager } from './clientManager'
import { MCP_SERVER_MAX_TOOLS } from './internal'
import type {
  McpConnection,
  McpConnectionCloseListener,
  McpConnector,
  McpRemoteTool,
  McpServerSnapshot,
  McpToolsChangedListener,
} from './types'

const HTTP_CONFIG = {
  id: 'remote',
  transport: 'streamable-http',
  url: 'https://mcp.example.test',
} as const

function remoteTool(name: string, description = name): McpRemoteTool {
  return {
    name,
    description,
    inputSchema: { type: 'object' },
  }
}

function localTool(name: string): Tool {
  return {
    name,
    runtime: 'internal',
    skill: { description: 'local', content: 'local' },
    inputSchema: { type: 'object' },
    execute: () => ({ ok: true, data: 'local' }),
  }
}

class FakeConnection implements McpConnection {
  tools: readonly McpRemoteTool[]
  listError: Error | undefined
  beforeList: ((signal?: AbortSignal) => void | Promise<void>) | undefined
  listCount = 0
  closeCount = 0
  readonly calls: Array<{
    name: string
    args: Record<string, unknown>
    signal?: AbortSignal
  }> = []
  private readonly toolsChangedListeners = new Set<McpToolsChangedListener>()
  private readonly closeListeners = new Set<McpConnectionCloseListener>()

  constructor(tools: readonly McpRemoteTool[]) {
    this.tools = tools
  }

  async listTools(options?: { signal?: AbortSignal }): Promise<readonly McpRemoteTool[]> {
    this.listCount += 1
    await this.beforeList?.(options?.signal)
    if (this.listError) throw this.listError
    return this.tools
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ) {
    this.calls.push({ name, args, signal: options?.signal })
    return {
      content: [{ type: 'text', text: `called ${name}` }],
      structuredContent: { args },
    }
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
    this.closeCount += 1
  }

  emitToolsChanged(): void {
    for (const listener of [...this.toolsChangedListeners]) listener()
  }

  emitUnexpectedClose(error?: Error): void {
    for (const listener of [...this.closeListeners]) listener(error)
  }
}

function connectorFor(...connections: FakeConnection[]): McpConnector {
  return {
    connect: vi.fn(async () => {
      const connection = connections.shift()
      if (!connection) throw new Error('No fake MCP connection available')
      return connection
    }),
  }
}

function waitForSnapshot(
  manager: McpClientManager,
  predicate: (snapshot: McpServerSnapshot) => boolean,
): Promise<McpServerSnapshot> {
  const current = manager.get(HTTP_CONFIG.id)
  if (current && predicate(current)) return Promise.resolve(current)

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe()
      reject(new Error('Timed out waiting for MCP manager snapshot'))
    }, 2_000)
    const unsubscribe = manager.subscribe((servers) => {
      const snapshot = servers.find((server) => server.id === HTTP_CONFIG.id)
      if (!snapshot || !predicate(snapshot)) return
      clearTimeout(timeout)
      unsubscribe()
      resolve(snapshot)
    })
  })
}

function context(signal: AbortSignal): ToolContext {
  return { signal } as ToolContext
}

describe('McpClientManager', () => {
  it('registers remote tools, executes them, and unregisters on disconnect', async () => {
    const registry = createToolRegistry()
    const connection = new FakeConnection([remoteTool('forecast')])
    const manager = new McpClientManager({
      registry,
      connector: connectorFor(connection),
    })

    const connected = await manager.connect(HTTP_CONFIG)
    expect(connected.status).toBe('connected')
    expect(connected.tools.map((tool) => tool.name)).toEqual([
      'mcp__remote__forecast',
    ])

    const controller = new AbortController()
    await expect(
      registry.run(
        'mcp__remote__forecast',
        { city: 'Shanghai' },
        context(controller.signal),
      ),
    ).resolves.toEqual({
      ok: true,
      data: {
        content: [{ type: 'text', text: 'called forecast' }],
        structuredContent: { args: { city: 'Shanghai' } },
      },
    })
    expect(connection.calls[0]).toMatchObject({
      name: 'forecast',
      args: { city: 'Shanghai' },
    })
    expect(connection.calls[0]?.signal).toBeDefined()
    expect(connection.calls[0]?.signal?.aborted).toBe(false)

    await expect(manager.disconnect(HTTP_CONFIG.id)).resolves.toMatchObject({
      status: 'disconnected',
      tools: [],
    })
    expect(connection.closeCount).toBe(1)
    expect(registry.has('mcp__remote__forecast')).toBe(false)
    await expect(
      registry.run(
        'mcp__remote__forecast',
        {},
        context(new AbortController().signal),
      ),
    ).resolves.toEqual({
      ok: false,
      error: 'unknown tool: mcp__remote__forecast',
    })
  })

  it('returns detached nested schemas from public snapshots', async () => {
    const registry = createToolRegistry()
    const connection = new FakeConnection([{
      name: 'nested',
      inputSchema: {
        type: 'object',
        properties: {
          city: { type: 'string' },
        },
      },
    }])
    const manager = new McpClientManager({
      registry,
      connector: connectorFor(connection),
    })

    const connected = await manager.connect(HTTP_CONFIG)
    const properties = connected.tools[0]?.inputSchema.properties
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
      throw new Error('Expected nested MCP input schema')
    }
    ;(properties as Record<string, unknown>).city = { type: 'number' }

    expect(manager.get(HTTP_CONFIG.id)?.tools[0]?.inputSchema).toMatchObject({
      properties: {
        city: { type: 'string' },
      },
    })
    expect(registry.loadSchema('mcp__remote__nested')?.inputSchema).toMatchObject({
      properties: {
        city: { type: 'string' },
      },
    })
  })

  it('reconciles tools/list_changed and unregisters stale names', async () => {
    const registry = createToolRegistry()
    const connection = new FakeConnection([
      remoteTool('alpha', 'alpha v1'),
      remoteTool('beta'),
    ])
    const manager = new McpClientManager({
      registry,
      connector: connectorFor(connection),
    })
    await manager.connect(HTTP_CONFIG)

    const changed = waitForSnapshot(
      manager,
      (snapshot) =>
        snapshot.tools.some((tool) => tool.remoteName === 'gamma') &&
        !snapshot.tools.some((tool) => tool.remoteName === 'beta'),
    )
    connection.tools = [
      remoteTool('alpha', 'alpha v2'),
      remoteTool('gamma'),
    ]
    connection.emitToolsChanged()
    await changed

    expect(registry.has('mcp__remote__beta')).toBe(false)
    expect(registry.has('mcp__remote__gamma')).toBe(true)
    expect(registry.loadSchema('mcp__remote__alpha')?.description).toContain(
      'alpha v2',
    )
  })

  it('keeps registration versions stable for semantically unchanged tool lists', async () => {
    const registry = createToolRegistry()
    const connection = new FakeConnection([{
      name: 'stable',
      title: 'Before',
      description: 'unchanged',
      inputSchema: {
        type: 'object',
        properties: {
          alpha: { type: 'string' },
          beta: { type: 'number' },
        },
      },
    }])
    const manager = new McpClientManager({
      registry,
      connector: connectorFor(connection),
    })
    await manager.connect(HTTP_CONFIG)

    const name = 'mcp__remote__stable'
    const initialVersion = registry.registrationVersion(name)
    const refreshed = new Promise<void>((resolve) => {
      const unsubscribe = manager.subscribe(() => {
        unsubscribe()
        resolve()
      })
    })
    connection.tools = [{
      name: 'stable',
      title: 'After',
      description: 'unchanged',
      inputSchema: {
        properties: {
          beta: { type: 'number' },
          alpha: { type: 'string' },
        },
        type: 'object',
      },
    }]
    connection.emitToolsChanged()
    await refreshed

    expect(registry.registrationVersion(name)).toBe(initialVersion)
    expect(manager.get(HTTP_CONFIG.id)?.tools[0]?.title).toBe('After')

    const changed = new Promise<void>((resolve) => {
      const unsubscribe = manager.subscribe(() => {
        unsubscribe()
        resolve()
      })
    })
    connection.tools = [{
      ...connection.tools[0]!,
      inputSchema: {
        type: 'object',
        properties: {
          alpha: { type: 'boolean' },
          beta: { type: 'number' },
        },
      },
    }]
    connection.emitToolsChanged()
    await changed

    expect(registry.registrationVersion(name)).toBe((initialVersion ?? 0) + 1)
  })

  it('fails closed into "reconnecting" (temporary) after an unclassified unexpected close', async () => {
    const registry = createToolRegistry()
    const connection = new FakeConnection([remoteTool('alpha')])
    const manager = new McpClientManager({
      registry,
      connector: connectorFor(connection),
    })
    await manager.connect(HTTP_CONFIG)

    const failed = waitForSnapshot(
      manager,
      (snapshot) => snapshot.status === 'reconnecting',
    )
    connection.emitUnexpectedClose(new Error('transport lost'))
    await expect(failed).resolves.toMatchObject({
      status: 'reconnecting',
      error: expect.stringContaining('transport lost'),
      tools: [],
    })
    expect(registry.has('mcp__remote__alpha')).toBe(false)
  })

  it('fails closed into "error" (permanent) when the close reason is an auth failure', async () => {
    const registry = createToolRegistry()
    const connection = new FakeConnection([remoteTool('alpha')])
    const manager = new McpClientManager({
      registry,
      connector: connectorFor(connection),
    })
    await manager.connect(HTTP_CONFIG)

    const failed = waitForSnapshot(
      manager,
      (snapshot) => snapshot.status === 'error',
    )
    const authError = new Error('Streamable HTTP error: unauthorized')
    ;(authError as unknown as { code: number }).code = 401
    connection.emitUnexpectedClose(authError)
    await expect(failed).resolves.toMatchObject({
      status: 'error',
      error: expect.stringContaining('身份认证失败'),
      tools: [],
    })
    expect(registry.has('mcp__remote__alpha')).toBe(false)
  })

  it('classifies a transient connector failure on first connect as "reconnecting"', async () => {
    const registry = createToolRegistry()
    const manager = new McpClientManager({
      registry,
      connector: {
        connect: vi.fn(async () => {
          throw new Error('fetch failed: ECONNREFUSED')
        }),
      },
    })

    await expect(manager.connect(HTTP_CONFIG)).rejects.toThrow('ECONNREFUSED')
    expect(manager.get(HTTP_CONFIG.id)).toMatchObject({
      status: 'reconnecting',
      tools: [],
    })
  })

  it('validates an entire changed list before mutation and preserves local conflicts', async () => {
    const registry = createToolRegistry()
    const connection = new FakeConnection([remoteTool('stable')])
    const manager = new McpClientManager({
      registry,
      connector: connectorFor(connection),
    })
    await manager.connect(HTTP_CONFIG)

    const local = localTool('mcp__remote__local')
    registry.register(local)
    connection.tools = [remoteTool('new'), remoteTool('local')]
    const failed = waitForSnapshot(
      manager,
      (snapshot) => snapshot.status === 'error',
    )
    connection.emitToolsChanged()
    await failed

    expect(registry.has(local.name, local)).toBe(true)
    expect(registry.has('mcp__remote__new')).toBe(false)
    expect(registry.has('mcp__remote__stable')).toBe(false)
  })

  it('fails closed when task-required tools appear initially or after list_changed', async () => {
    const requiredTool: McpRemoteTool = {
      ...remoteTool('long-running-job'),
      execution: { taskSupport: 'required' },
    }
    const initialRegistry = createToolRegistry()
    const initialConnection = new FakeConnection([requiredTool])
    const initialManager = new McpClientManager({
      registry: initialRegistry,
      connector: connectorFor(initialConnection),
    })

    await expect(initialManager.connect(HTTP_CONFIG)).rejects.toThrow(
      'does not support MCP Tasks',
    )
    expect(initialManager.get(HTTP_CONFIG.id)).toMatchObject({
      status: 'error',
      tools: [],
    })
    expect(initialConnection.closeCount).toBe(1)

    const changedRegistry = createToolRegistry()
    const changedConnection = new FakeConnection([remoteTool('stable')])
    const changedManager = new McpClientManager({
      registry: changedRegistry,
      connector: connectorFor(changedConnection),
    })
    await changedManager.connect(HTTP_CONFIG)
    changedConnection.tools = [requiredTool]
    const failed = waitForSnapshot(
      changedManager,
      (snapshot) => snapshot.status === 'error',
    )
    changedConnection.emitToolsChanged()

    await expect(failed).resolves.toMatchObject({
      status: 'error',
      error: expect.stringContaining('does not support MCP Tasks'),
      tools: [],
    })
    expect(changedRegistry.has('mcp__remote__stable')).toBe(false)
  })

  it('coalesces list_changed bursts into one active and one dirty refresh', async () => {
    const registry = createToolRegistry()
    const connection = new FakeConnection([remoteTool('stable')])
    const manager = new McpClientManager({
      registry,
      connector: connectorFor(connection),
    })
    await manager.connect(HTTP_CONFIG)

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    connection.beforeList = () => gate

    for (let index = 0; index < 20; index += 1) {
      connection.emitToolsChanged()
    }
    await vi.waitFor(() => expect(connection.listCount).toBe(2))
    for (let index = 0; index < 20; index += 1) {
      connection.emitToolsChanged()
    }
    release()

    await vi.waitFor(() => expect(connection.listCount).toBe(3))
    await Promise.resolve()
    expect(connection.listCount).toBe(3)
  })

  it('aborts an active tools refresh before disconnecting', async () => {
    const registry = createToolRegistry()
    const connection = new FakeConnection([remoteTool('stable')])
    const manager = new McpClientManager({
      registry,
      connector: connectorFor(connection),
    })
    await manager.connect(HTTP_CONFIG)

    let refreshAborted = false
    connection.beforeList = (signal) => new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => {
        refreshAborted = true
        const error = new Error('refresh aborted')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    })
    connection.emitToolsChanged()
    await vi.waitFor(() => expect(connection.listCount).toBe(2))

    await expect(manager.disconnect(HTTP_CONFIG.id)).resolves.toMatchObject({
      status: 'disconnected',
      tools: [],
    })
    expect(refreshAborted).toBe(true)
    expect(connection.closeCount).toBe(1)
  })

  it('rejects empty names and connector lists above the manager limit', async () => {
    const registry = createToolRegistry()
    const emptyName = new FakeConnection([
      { name: '', inputSchema: { type: 'object' } },
    ])
    const manager = new McpClientManager({
      registry,
      connector: connectorFor(emptyName),
    })

    await expect(manager.connect(HTTP_CONFIG)).rejects.toThrow('empty name')
    expect(manager.get(HTTP_CONFIG.id)).toMatchObject({
      status: 'error',
      tools: [],
    })

    const oversized = new FakeConnection(
      Array.from({ length: MCP_SERVER_MAX_TOOLS + 1 }, (_, index) =>
        remoteTool(`tool-${index}`),
      ),
    )
    const oversizedManager = new McpClientManager({
      registry,
      connector: connectorFor(oversized),
    })
    await expect(
      oversizedManager.connect({ ...HTTP_CONFIG, id: 'oversized' }),
    ).rejects.toThrow(`exceeded ${MCP_SERVER_MAX_TOOLS} tools`)
    expect(registry.list()).toEqual([])
  })

  it('accepts an empty list as a valid removal of every old tool', async () => {
    const registry = createToolRegistry()
    const connection = new FakeConnection([remoteTool('temporary')])
    const manager = new McpClientManager({
      registry,
      connector: connectorFor(connection),
    })
    await manager.connect(HTTP_CONFIG)

    connection.tools = []
    const emptied = waitForSnapshot(
      manager,
      (snapshot) => snapshot.status === 'connected' && snapshot.tools.length === 0,
    )
    connection.emitToolsChanged()
    await emptied

    expect(registry.has('mcp__remote__temporary')).toBe(false)
  })

  it('reconnects with the saved config and remove clears connection and snapshots', async () => {
    const registry = createToolRegistry()
    const first = new FakeConnection([remoteTool('old')])
    const second = new FakeConnection([remoteTool('new')])
    const connector = connectorFor(first, second)
    const manager = new McpClientManager({ registry, connector })
    const observer = vi.fn()
    const unsubscribe = manager.subscribe(observer)

    await manager.connect(HTTP_CONFIG)
    const reconnected = await manager.reconnect(HTTP_CONFIG.id)

    expect(reconnected.status).toBe('connected')
    expect(reconnected.tools.map((tool) => tool.remoteName)).toEqual(['new'])
    expect(first.closeCount).toBe(1)
    expect(registry.has('mcp__remote__old')).toBe(false)
    expect(registry.has('mcp__remote__new')).toBe(true)
    expect(connector.connect).toHaveBeenLastCalledWith(
      HTTP_CONFIG,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(manager.list()).toHaveLength(1)
    expect(manager.listTools()).toHaveLength(1)
    expect(observer).toHaveBeenCalled()

    await expect(manager.remove(HTTP_CONFIG.id)).resolves.toBe(true)
    expect(second.closeCount).toBe(1)
    expect(manager.list()).toEqual([])
    expect(registry.has('mcp__remote__new')).toBe(false)
    await expect(manager.remove(HTTP_CONFIG.id)).resolves.toBe(false)
    unsubscribe()
  })
})
