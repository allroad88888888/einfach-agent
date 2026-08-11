import type { ToolRegistry } from '@web-agent/core/tools/toolRegistry'
import { MCP_SERVER_MAX_TOOLS } from './internal'
import { runtimeFor } from './serverConfig'
import { cloneMcpInputSchema, createMcpToolAdapter } from './toolAdapter'
import type {
  McpConnection,
  McpOperationOptions,
  McpRegisteredTool,
  McpServerConfig,
  McpToolSnapshot,
} from './types'

/**
 * 把一个 MCP 服务的远端工具清单**对账**进 ToolRegistry：拉清单、校验、算出增删改、
 * 落 registry，返回新的已注册表。
 *
 * 与 clientManager.ts 分开是因为这里没有连接生命周期的概念 —— 它拿到的是一条已经能用的
 * 连接，只负责让 registry 里属于该服务的那批工具与远端一致。
 */

export function cloneToolSnapshot(snapshot: McpToolSnapshot): McpToolSnapshot {
  return {
    ...snapshot,
    inputSchema: cloneMcpInputSchema(snapshot.inputSchema),
  }
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameJsonValue(value, right[index]))
  }
  if (
    !left
    || !right
    || typeof left !== 'object'
    || typeof right !== 'object'
  ) {
    return false
  }

  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  return leftKeys.length === rightKeys.length
    && leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key)
        && sameJsonValue(leftRecord[key], rightRecord[key]),
    )
}

function canReuseRegisteredTool(
  previous: McpRegisteredTool,
  next: McpRegisteredTool,
): boolean {
  return previous.snapshot.remoteName === next.snapshot.remoteName
    && previous.tool.name === next.tool.name
    && previous.tool.runtime === next.tool.runtime
    && previous.tool.skill.description === next.tool.skill.description
    && previous.tool.skill.content === next.tool.skill.content
    && sameJsonValue(previous.tool.inputSchema, next.tool.inputSchema)
    && sameJsonValue(previous.tool.execution, next.tool.execution)
}

export interface ReconcileMcpToolsParams {
  registry: ToolRegistry
  config: McpServerConfig
  connection: McpConnection
  /** 该服务当前已注册的工具，按 ToolRegistry 名索引。 */
  registered: ReadonlyMap<string, McpRegisteredTool>
  options?: McpOperationOptions
}

/**
 * 抛出即表示 registry 未被改动：全部校验在任何注册/注销之前完成。
 * 调用方需要把返回值写回自己的 registered 表。
 */
export async function reconcileMcpTools(
  params: ReconcileMcpToolsParams,
): Promise<Map<string, McpRegisteredTool>> {
  const { registry, config, connection, registered, options } = params
  const remoteTools = await connection.listTools(options)
  if (!Array.isArray(remoteTools)) {
    throw new Error(`MCP server "${config.id}" returned an invalid tool list`)
  }
  if (remoteTools.length > MCP_SERVER_MAX_TOOLS) {
    throw new Error(`MCP server "${config.id}" exceeded ${MCP_SERVER_MAX_TOOLS} tools`)
  }
  const next = new Map<string, McpRegisteredTool>()

  for (const remoteTool of remoteTools) {
    if (
      !remoteTool ||
      typeof remoteTool.name !== 'string' ||
      !remoteTool.name.trim()
    ) {
      throw new Error(`MCP server "${config.id}" returned a tool with an empty name`)
    }
    const adapted = createMcpToolAdapter({
      serverId: config.id,
      remoteTool,
      connection,
      runtime: runtimeFor(config),
    })
    const name = adapted.tool.name
    if (next.has(name)) {
      throw new Error(
        `MCP server "${config.id}" returned colliding tool names for "${name}"`,
      )
    }

    const previous = registered.get(name)
    if (
      registry.has(name) &&
      (!previous || !registry.has(name, previous.tool))
    ) {
      throw new Error(`MCP tool name conflicts with an existing tool: ${name}`)
    }
    next.set(
      name,
      previous && canReuseRegisteredTool(previous, adapted)
        ? { tool: previous.tool, snapshot: adapted.snapshot }
        : adapted,
    )
  }

  // All remote metadata and collisions are validated before mutating registry.
  for (const [name, adapted] of next) {
    const previous = registered.get(name)
    if (!previous || previous.tool !== adapted.tool) {
      registry.register(adapted.tool)
    }
  }
  for (const [name, previous] of registered) {
    if (!next.has(name)) {
      registry.unregister(name, previous.tool)
    }
  }
  return next
}
