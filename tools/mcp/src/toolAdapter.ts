import type { Tool, ToolResult, ToolRuntime } from '@web-agent/core/tools/types'
import {
  combineAbortSignals,
  errorMessage,
  isRecord,
  raceWithAbort,
  throwIfAborted,
  truncate,
} from './internal'
import {
  isDeclaredReadOnly,
  normalizedDescription,
  normalizedGuide,
} from './toolMetadataText'
import type {
  McpCallToolResult,
  McpConnection,
  McpRemoteTool,
  McpRegisteredTool,
} from './types'

// 文案规范化（description / guide 及其两条上限）搬到了 toolMetadataText.ts——占位工具要和
// 真实工具共用同一个函数，见那里的文件头。公开面在这里原样 re-export，调用方无感。
export {
  MCP_DESCRIPTION_MAX_CHARS,
  MCP_GUIDE_MAX_CHARS,
  normalizedDescription,
} from './toolMetadataText'

export const MCP_TOOL_NAME_MAX_CHARS = 64
export const MCP_TITLE_MAX_CHARS = 128
export const MCP_ERROR_MAX_CHARS = 4_000
export const MCP_INPUT_SCHEMA_MAX_CHARS = 128_000
export const MCP_INPUT_SCHEMA_MAX_DEPTH = 32
export const MCP_INPUT_SCHEMA_MAX_NODES = 4_000
export const MCP_TOOL_RESULT_MAX_CHARS = 1_000_000
export const MCP_TOOL_RESULT_MAX_DEPTH = 64
export const MCP_TOOL_RESULT_MAX_NODES = 20_000
export const MCP_TOOL_CALL_TIMEOUT_MS = 3_600_000
export const MCP_TOOL_RESULT_DROPPED_MARKER = {
  outputDropped: true,
  reason: 'unsafe_or_oversized_output',
  message:
    'The MCP tool call completed successfully, but its output was dropped by a safety limit. Do not retry the tool solely to retrieve this output.',
} as const

const SAFE_NAME_SEGMENT = /^[A-Za-z0-9_-]+$/
const SAFE_NAME_CHAR = /[A-Za-z0-9_-]/

interface BoundedJsonLimits {
  maxChars: number
  maxDepth: number
  maxNodes: number
}

interface PendingJsonValue {
  value: unknown
  depth: number
  assign(value: unknown): void
}

function jsonPrimitiveLength(value: string | number | boolean | null): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error('value is not JSON serializable')
  return serialized.length
}

/**
 * Validates and clones transport data without recursive traversal. Apart from
 * enforcing the model-context budget, this prevents cyclic/prototyped data
 * injected by custom connectors from reaching recursive schema consumers.
 */
function cloneBoundedJson(
  value: unknown,
  label: string,
  limits: BoundedJsonLimits,
): unknown {
  let cloned: unknown
  let chars = 0
  let nodes = 0
  const seen = new WeakSet<object>()
  const pending: PendingJsonValue[] = [{
    value,
    depth: 0,
    assign(next) {
      cloned = next
    },
  }]

  const addChars = (amount: number) => {
    chars += amount
    if (chars > limits.maxChars) {
      throw new Error(`${label} exceeds the ${limits.maxChars}-character safety limit`)
    }
  }

  while (pending.length > 0) {
    const current = pending.pop()!
    nodes += 1
    if (nodes > limits.maxNodes) {
      throw new Error(`${label} exceeds the ${limits.maxNodes}-node safety limit`)
    }
    if (current.depth > limits.maxDepth) {
      throw new Error(`${label} exceeds the ${limits.maxDepth}-level depth limit`)
    }

    const currentValue = current.value
    if (
      currentValue === null
      || typeof currentValue === 'string'
      || typeof currentValue === 'boolean'
    ) {
      addChars(jsonPrimitiveLength(currentValue))
      current.assign(currentValue)
      continue
    }
    if (typeof currentValue === 'number') {
      if (!Number.isFinite(currentValue)) {
        throw new Error(`${label} contains a non-finite number`)
      }
      addChars(jsonPrimitiveLength(currentValue))
      current.assign(currentValue)
      continue
    }
    if (typeof currentValue !== 'object') {
      throw new Error(`${label} contains a non-JSON value`)
    }
    if (seen.has(currentValue)) {
      throw new Error(`${label} contains a cyclic or repeated object reference`)
    }
    seen.add(currentValue)

    if (Array.isArray(currentValue)) {
      const target: unknown[] = new Array(currentValue.length)
      addChars(2 + Math.max(0, currentValue.length - 1))
      current.assign(target)
      for (let index = currentValue.length - 1; index >= 0; index -= 1) {
        pending.push({
          value: currentValue[index],
          depth: current.depth + 1,
          assign(next) {
            target[index] = next
          },
        })
      }
      continue
    }

    const prototype = Object.getPrototypeOf(currentValue)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} contains a non-JSON object`)
    }
    if (Object.getOwnPropertySymbols(currentValue).length > 0) {
      throw new Error(`${label} contains a symbol-keyed value`)
    }

    const entries = Object.entries(currentValue)
    const target: Record<string, unknown> = {}
    addChars(2 + Math.max(0, entries.length - 1))
    current.assign(target)
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index]!
      addChars(jsonPrimitiveLength(key) + 1)
      pending.push({
        value: child,
        depth: current.depth + 1,
        assign(next) {
          Object.defineProperty(target, key, {
            value: next,
            enumerable: true,
            configurable: true,
            writable: true,
          })
        },
      })
    }
  }

  return cloned
}

/** Returns a detached, bounded copy suitable for exposing in manager snapshots. */
export function cloneMcpInputSchema(
  inputSchema: Record<string, unknown>,
  label = 'MCP input schema',
): Record<string, unknown> {
  return cloneBoundedJson(
    inputSchema,
    label,
    {
      maxChars: MCP_INPUT_SCHEMA_MAX_CHARS,
      maxDepth: MCP_INPUT_SCHEMA_MAX_DEPTH,
      maxNodes: MCP_INPUT_SCHEMA_MAX_NODES,
    },
  ) as Record<string, unknown>
}

function stableNameHash(value: string): string {
  // FNV-1a 64-bit, rendered as a 10-character base36 suffix (~52 bits).
  let hash = 0xcbf29ce484222325n
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(36).padStart(13, '0').slice(-10)
}

function safePrefix(value: string, maxChars: number): string {
  let result = ''
  for (const character of value) {
    result += SAFE_NAME_CHAR.test(character) ? character : '_'
    if (result.length >= maxChars) break
  }
  return result || '_'
}

/**
 * Provider-safe and stable ToolRegistry name.
 *
 * Short ASCII names retain the readable `mcp__server__tool` form. Escaped or
 * truncated names carry a hash of both raw names, preventing lossy-prefix
 * collisions while staying within the common 64-character provider limit.
 */
export function makeMcpToolName(serverId: string, remoteToolName: string): string {
  if (!serverId) throw new Error('MCP server id must not be empty')
  if (!remoteToolName) throw new Error('MCP remote tool name must not be empty')

  const readable = `mcp__${serverId}__${remoteToolName}`
  if (
    readable.length <= MCP_TOOL_NAME_MAX_CHARS &&
    SAFE_NAME_SEGMENT.test(serverId) &&
    SAFE_NAME_SEGMENT.test(remoteToolName)
  ) {
    return readable
  }

  const hash = stableNameHash(`${serverId}\u0000${remoteToolName}`)
  const name = `mcp__${safePrefix(serverId, 20)}__${safePrefix(remoteToolName, 25)}__${hash}`
  return name.slice(0, MCP_TOOL_NAME_MAX_CHARS)
}

function normalizeInputSchema(tool: McpRemoteTool): Record<string, unknown> {
  const inputSchema = tool.inputSchema
  if (!isRecord(inputSchema) || inputSchema.type !== 'object') {
    throw new Error(`MCP tool "${tool.name}" has a non-object input schema`)
  }
  const cloned = cloneMcpInputSchema(
    inputSchema,
    `MCP tool "${truncate(tool.name, 120)}" input schema`,
  )
  Object.defineProperty(cloned, 'type', {
    value: 'object',
    enumerable: true,
    configurable: true,
    writable: true,
  })
  return cloned
}

function assertSupportedToolExecution(tool: McpRemoteTool): void {
  if (
    isRecord(tool.execution)
    && tool.execution.taskSupport === 'required'
  ) {
    throw new Error(
      `MCP tool "${truncate(tool.name, 120)}" requires task-based execution, but this client does not support MCP Tasks`,
    )
  }
}

function boundedErrorContentText(content: readonly unknown[]): string | undefined {
  let combined = ''
  const inspectedItems = Math.min(content.length, MCP_TOOL_RESULT_MAX_NODES)

  for (let index = 0; index < inspectedItems; index += 1) {
    const item = content[index]
    if (!isRecord(item) || item.type !== 'text' || typeof item.text !== 'string') {
      continue
    }

    const prefix = combined ? '\n' : ''
    const remaining = MCP_ERROR_MAX_CHARS - combined.length
    if (prefix.length + item.text.length <= remaining) {
      combined += prefix
      combined += item.text
      continue
    }

    if (remaining <= 0) {
      return `${combined.slice(0, Math.max(0, MCP_ERROR_MAX_CHARS - 1))}…`
    }
    const availableText = Math.max(0, remaining - prefix.length - 1)
    combined += prefix.slice(0, Math.max(0, remaining - 1))
    combined += item.text.slice(0, availableText)
    return `${combined.slice(0, Math.max(0, MCP_ERROR_MAX_CHARS - 1))}…`
  }

  return combined || undefined
}

function errorText(result: McpCallToolResult): string {
  if (typeof result.error === 'string' && result.error) {
    return truncate(result.error, MCP_ERROR_MAX_CHARS)
  }

  if (Array.isArray(result.content)) {
    const text = boundedErrorContentText(result.content)
    if (text) return truncate(text, MCP_ERROR_MAX_CHARS)
  } else if (typeof result.content === 'string' && result.content) {
    return truncate(result.content, MCP_ERROR_MAX_CHARS)
  }

  if (
    isRecord(result.structuredContent) &&
    typeof result.structuredContent.message === 'string'
  ) {
    return truncate(result.structuredContent.message, MCP_ERROR_MAX_CHARS)
  }
  return 'MCP tool returned an error'
}

/** Maps an SDK-neutral MCP call result into the core ToolResult contract. */
export function normalizeMcpToolResult(result: McpCallToolResult): ToolResult {
  if (result.isError === true) {
    return {
      ok: false,
      error: errorText(result),
      code: 'MCP_REMOTE_ERROR',
      retryable: false,
    }
  }

  const visibleData: Record<string, unknown> = {
    content: result.content ?? [],
  }
  if (Object.prototype.hasOwnProperty.call(result, 'structuredContent')) {
    visibleData.structuredContent = result.structuredContent
  }

  try {
    const data = cloneBoundedJson(
      visibleData,
      'MCP tool result',
      {
        maxChars: MCP_TOOL_RESULT_MAX_CHARS,
        maxDepth: MCP_TOOL_RESULT_MAX_DEPTH,
        maxNodes: MCP_TOOL_RESULT_MAX_NODES,
      },
    )
    return { ok: true, data }
  } catch {
    return {
      ok: true,
      data: { ...MCP_TOOL_RESULT_DROPPED_MARKER },
    }
  }
}

export interface CreateMcpToolAdapterOptions {
  serverId: string
  remoteTool: McpRemoteTool
  connection: McpConnection
  runtime: ToolRuntime
  /** Per-call deadline. Mainly configurable for hosts and deterministic tests. */
  callTimeoutMs?: number
}

export function createMcpToolAdapter({
  serverId,
  remoteTool,
  connection,
  runtime,
  callTimeoutMs = MCP_TOOL_CALL_TIMEOUT_MS,
}: CreateMcpToolAdapterOptions): McpRegisteredTool {
  if (!Number.isFinite(callTimeoutMs) || callTimeoutMs < 1) {
    throw new Error('MCP tool call timeout must be a positive number')
  }
  assertSupportedToolExecution(remoteTool)
  const name = makeMcpToolName(serverId, remoteTool.name)
  const inputSchema = normalizeInputSchema(remoteTool)
  const description = normalizedDescription(serverId, remoteTool)
  const title =
    typeof remoteTool.title === 'string'
      ? truncate(remoteTool.title, MCP_TITLE_MAX_CHARS)
      : undefined
  const declaredReadOnly = isDeclaredReadOnly(remoteTool)

  const tool: Tool = {
    name,
    runtime,
    skill: {
      description,
      content: normalizedGuide(serverId, remoteTool),
    },
    inputSchema,
    execution: {
      mode: declaredReadOnly ? 'parallel' : 'serial',
      effectKeys: [
        declaredReadOnly
          ? `external:mcp:${serverId}:read`
          : `external:mcp:${serverId}`,
      ],
    },
    async execute(args, context) {
      throwIfAborted(context.signal)
      if (!isRecord(args)) {
        return {
          ok: false,
          error: 'MCP tool arguments must be an object',
          code: 'MCP_INVALID_ARGUMENTS',
          retryable: false,
        }
      }

      const timeoutController = new AbortController()
      const combined = combineAbortSignals(context.signal, timeoutController.signal)
      let timedOut = false
      const timeoutId = setTimeout(() => {
        timedOut = true
        timeoutController.abort(new Error(
          `MCP tool call timed out after ${callTimeoutMs}ms`,
        ))
      }, callTimeoutMs)

      try {
        const result = await raceWithAbort(
          connection.callTool(remoteTool.name, args, {
            signal: combined.signal,
          }),
          combined.signal,
        )
        return normalizeMcpToolResult(result)
      } catch (error) {
        // User/session cancellation remains control flow and must not be turned
        // into a retryable transport failure.
        throwIfAborted(context.signal)
        if (timedOut) {
          return {
            ok: false,
            error: `MCP tool call timed out after ${callTimeoutMs}ms`,
            code: 'MCP_TOOL_TIMEOUT',
            retryable: true,
            hint: 'Retry once, or check whether the MCP server is responsive.',
            details: { timeoutMs: callTimeoutMs, serverId, remoteTool: remoteTool.name },
          }
        }
        return {
          ok: false,
          error: `MCP transport failed: ${truncate(errorMessage(error), MCP_ERROR_MAX_CHARS)}`,
          code: 'MCP_TRANSPORT_ERROR',
          retryable: true,
          hint: 'Check the MCP server connection before retrying.',
          details: { serverId, remoteTool: remoteTool.name },
        }
      } finally {
        clearTimeout(timeoutId)
        combined.dispose()
      }
    },
  }

  return {
    tool,
    snapshot: {
      name,
      remoteName: remoteTool.name,
      ...(title ? { title } : {}),
      description,
      inputSchema,
    },
  }
}
