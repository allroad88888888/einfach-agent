import type { ToolRegistry } from '@web-agent/core/tools/toolRegistry'
import type { Tool } from '@web-agent/core/tools/types'
import { MCP_SERVER_MAX_TOOLS } from './internal'
import type { McpPlaceholderClaims } from './placeholderClaims'
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
  /**
   * 占位工具登记表（可选）。不接这根线 = 系统里没有占位，行为与占位上线前逐字节一致。
   *
   * 接上之后它只影响两件事：冲突判定放行本服务占位占着的名字，以及覆盖阶段释放这些登记。
   */
  placeholders?: McpPlaceholderClaims
  options?: McpOperationOptions
}

/**
 * 抛出即表示 registry 未被改动：全部校验在任何注册/注销之前完成，占位登记同样一条不释放。
 * 调用方需要把返回值写回自己的 registered 表。
 */
export async function reconcileMcpTools(
  params: ReconcileMcpToolsParams,
): Promise<Map<string, McpRegisteredTool>> {
  const { registry, config, connection, registered, placeholders, options } = params
  const remoteTools = await connection.listTools(options)
  if (!Array.isArray(remoteTools)) {
    throw new Error(`MCP server "${config.id}" returned an invalid tool list`)
  }
  if (remoteTools.length > MCP_SERVER_MAX_TOOLS) {
    throw new Error(`MCP server "${config.id}" exceeded ${MCP_SERVER_MAX_TOOLS} tools`)
  }
  const next = new Map<string, McpRegisteredTool>()
  /**
   * 本服务占位占着、覆盖阶段要释放的名字 → 当初登记的那个占位实例。
   *
   * 校验阶段只记账、不释放：`reconcileMcpTools` 的既有契约是「抛出即什么都没被改动」，
   * 占位登记也算「被改动」——校验中途抛错时，占位必须原封不动地继续占着名字。
   */
  const claimedByThisServer = new Map<string, Tool>()

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
    // 放行「本服务占位占着的名字」：判据来自占位登记表，不看名字长相。两个条件缺一不可 ——
    // 登记说这是本服务的占位，且 registry 里当前那份注册确实还是这个占位实例。后者防的是
    // 过期登记：占位一旦被别人的真实工具覆盖，这个名字就不再属于本服务，仍按冲突处理。
    const placeholder = placeholders?.owns(config.id, name)
      ? placeholders.get(name)?.tool
      : undefined
    const heldByOwnPlaceholder = placeholder !== undefined && registry.has(name, placeholder)
    if (heldByOwnPlaceholder) claimedByThisServer.set(name, placeholder)
    if (
      registry.has(name) &&
      (!previous || !registry.has(name, previous.tool)) &&
      !heldByOwnPlaceholder
    ) {
      throw new Error(`MCP tool name conflicts with an existing tool: ${name}`)
    }
    next.set(
      name,
      // 复用旧实例的前提是 registry 里现在挂着的就是它；名字正被本服务占位占着时显然不是。
      // 此时若还复用，下面的覆盖阶段会因为「实例没变」跳过 register，占位就永远盖不掉了。
      previous && !heldByOwnPlaceholder && canReuseRegisteredTool(previous, adapted)
        ? { tool: previous.tool, snapshot: adapted.snapshot }
        : adapted,
    )
  }

  // All remote metadata and collisions are validated before mutating registry.
  for (const [name, adapted] of next) {
    const previous = registered.get(name)
    if (!previous || previous.tool !== adapted.tool) {
      // 同名占位在这里被真实工具直接覆盖：register 后注册者胜，并签发更高的注册版本，
      // 下一轮 refreshVisibleTools 因此会把占位快照换成带真实 schema 的那一份。
      registry.register(adapted.tool)
    }
  }
  // 真实工具已经接管这些名字，占位登记随之作废。释放只发生在 mutate 阶段，
  // 且一律用 expected 形式——绝不误伤别人后来登记的同名占位。
  for (const [name, placeholder] of claimedByThisServer) {
    placeholders?.release(name, placeholder)
  }
  for (const [name, previous] of registered) {
    if (!next.has(name)) {
      registry.unregister(name, previous.tool)
    }
  }
  return next
}
