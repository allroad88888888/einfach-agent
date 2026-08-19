// server 版 stdio connector 用例的共用夹具。
// ---------------------------------------------------------------------------
// 两个用例文件共用（连接/命令那半在 `serverStdioConnector.test.ts`，事件与重连补偿那半在
// `serverStdioConnector.events.test.ts`）。`vi.mock` 必须写在各自的用例文件里（它按文件提升），
// 所以本文件只造对象、不替模块。

import type { McpServerConfig } from '@einfach-agent/tools-mcp'
import { ServerInvokeError } from '../host/serverInvoke'
import {
  createSseFetchHarness,
  fakeTokenEnvironment,
  type SseFetchHarness,
} from './serverHostEventStream.testHarness'
import { MCP_COMMAND_FAILURE_STATUS } from './serverMcpCommands'
import { ServerStdioMcpConnector } from './serverStdioConnector'

export interface ConnectorUnderTest {
  readonly connector: ServerStdioMcpConnector
  readonly sse: SseFetchHarness
}

/** 造一个把事件流指向假传输的 connector；退避设 0，用例不必真等。 */
export function createConnectorUnderTest(): ConnectorUnderTest {
  const sse = createSseFetchHarness()
  const connector = new ServerStdioMcpConnector({
    events: {
      fetch: sse.fetchImpl,
      tokenEnvironment: fakeTokenEnvironment('tok-1'),
      initialReconnectDelayMs: 0,
      maxReconnectDelayMs: 0,
      onStreamError: () => {},
    },
  })
  return { connector, sse }
}

export function stdioConfig(id = 'local'): McpServerConfig {
  return { id, name: '本地服务', transport: 'stdio', command: 'node' }
}

/** 一次调用的实参形状：四条 mcp 命令的载荷都包在 `input` 里，这里把那一层剥开。 */
export function commandInputs(
  calls: readonly unknown[][],
  command: string,
): Array<Record<string, unknown>> {
  return calls.flatMap((call) => {
    if (call[0] !== command) return []
    return [(call[1] as { input: Record<string, unknown> }).input]
  })
}

/**
 * 一次带结构化 kind 的命令失败。
 *
 * **这是服务端补上 `McpCommandError` 映射之后的形状**：`502` + `error` 字段就是 kind
 * （理由见 `serverMcpCommands.ts` 文件头「kind 目前穿不过 HTTP」）。今天的服务端还会把它
 * 塌成一条 text/plain 的 500，那种形态由 `serverInvokeOpaqueFailure()` 单独造。
 */
export function serverInvokeFailure(kind: string, message: string): ServerInvokeError {
  return new ServerInvokeError({ status: MCP_COMMAND_FAILURE_STATUS, code: kind, message })
}

/** 今天真实发生的形态：`apps/server` 把 `McpCommandError` 重抛成一条不带信封的 500。 */
export function serverInvokeOpaqueFailure(): ServerInvokeError {
  return new ServerInvokeError({
    status: 500,
    code: undefined,
    message: '本地服务返回了非预期的错误响应（HTTP 500）。',
  })
}
