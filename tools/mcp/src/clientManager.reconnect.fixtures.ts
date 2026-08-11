import { createToolRegistry } from '@web-agent/core/tools/toolRegistry'
import { vi } from 'vitest'
import { McpClientManager } from './clientManager'
import type {
  McpConnection,
  McpConnectionCloseListener,
  McpConnector,
  McpRemoteTool,
  McpToolsChangedListener,
} from './types'

/** 退避重连测试共用的替身与时间推进工具（假定时器口径）。 */

export const HTTP_CONFIG = {
  id: 'remote',
  transport: 'streamable-http',
  url: 'https://mcp.example.test',
} as const

/** 退避序列：1s→2s→4s→8s→16s→30s，共 6 次。 */
export const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]

export function remoteTool(name: string): McpRemoteTool {
  return { name, description: name, inputSchema: { type: 'object' } }
}

/** 判成暂时失败：无结构化 kind、无 HTTP 状态、文案不命中永久规则。 */
export function temporaryError(message = 'connect refused'): Error {
  return new Error(message)
}

/** 判成永久失败：401 是传输层观测到的结构化信号。 */
export function authError(): Error {
  const error = new Error('rejected')
  ;(error as unknown as { code: number }).code = 401
  return error
}

export class FakeConnection implements McpConnection {
  listCount = 0
  closeCount = 0
  private readonly closeListeners = new Set<McpConnectionCloseListener>()
  private readonly toolsChangedListeners = new Set<McpToolsChangedListener>()
  /** 退订后仍保留，用来模拟传输层回调迟到。 */
  private readonly everCloseListeners: McpConnectionCloseListener[] = []
  private readonly everToolsChangedListeners: McpToolsChangedListener[] = []

  constructor(readonly tools: readonly McpRemoteTool[]) {}

  async listTools(): Promise<readonly McpRemoteTool[]> {
    this.listCount += 1
    return this.tools
  }

  async callTool() { return {} }

  onToolsChanged(listener: McpToolsChangedListener): () => void {
    this.toolsChangedListeners.add(listener)
    this.everToolsChangedListeners.push(listener)
    return () => this.toolsChangedListeners.delete(listener)
  }

  onClose(listener: McpConnectionCloseListener): () => void {
    this.closeListeners.add(listener)
    this.everCloseListeners.push(listener)
    return () => this.closeListeners.delete(listener)
  }

  async close(): Promise<void> { this.closeCount += 1 }

  emitUnexpectedClose(error: Error): void {
    for (const listener of [...this.closeListeners]) listener(error)
  }

  /** 连接早已被换掉，但传输层仍然回调 —— 世代检查唯一真正要挡住的东西。 */
  emitStaleCallbacks(): void {
    for (const listener of [...this.everCloseListeners]) listener(temporaryError('late'))
    for (const listener of [...this.everToolsChangedListeners]) void listener()
  }
}

export type ConnectStep = FakeConnection | Error | (() => Promise<FakeConnection>)

export class ScriptedConnector implements McpConnector {
  connectCount = 0
  /** 步骤用尽后每次 connect 都用 fallback。 */
  fallback: ConnectStep = temporaryError()

  constructor(private readonly steps: ConnectStep[]) {}

  async connect(): Promise<McpConnection> {
    this.connectCount += 1
    const step = this.steps.shift() ?? this.fallback
    if (step instanceof Error) throw step
    return typeof step === 'function' ? await step() : step
  }
}

export async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

export async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await settle()
}

/** 连上一个带 alpha 工具的服务，随后可以让它断线。 */
export async function connected(...laterSteps: ConnectStep[]) {
  const registry = createToolRegistry()
  const live = new FakeConnection([remoteTool('alpha')])
  const connector = new ScriptedConnector([live, ...laterSteps])
  const manager = new McpClientManager({ registry, connector })
  await manager.connect(HTTP_CONFIG)
  return { registry, connector, manager, live, status: () => manager.get(HTTP_CONFIG.id)?.status }
}

/** 断线并让 failClosed 跑完，返回时退避已经排好。 */
export async function dropConnection(connection: FakeConnection): Promise<void> {
  connection.emitUnexpectedClose(temporaryError('transport lost'))
  await settle()
}
