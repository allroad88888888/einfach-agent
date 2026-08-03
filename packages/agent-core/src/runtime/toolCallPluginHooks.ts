import { validateAgainstSchema } from '../tools/schemaValidate'
import type { ToolResult } from '../tools/types'
import { executeToolCall, type ExecutableToolCall } from './toolCallExecutor'
import type { ToolLoopBase } from './toolLoopContracts'
import { safeErrorMessage } from './toolLoopSupport'
import {
  applyToolResultPatch,
  InvalidToolResultPatchError,
  type CompletedToolResult,
} from './toolResultPatch'

export interface PreparedToolCall {
  call: ExecutableToolCall
  schemaWarnings?: string[]
  beforeToolHookCompleted?: true
}

export type ToolCallPreparation =
  | { kind: 'ready'; prepared: PreparedToolCall }
  | { kind: 'rejected'; result: CompletedToolResult }

/** Returns whether a call batch must use the hook-aware serial execution path. */
export function hasToolCallHooks(base: ToolLoopBase): boolean {
  return base.hooks.beforeToolCall !== undefined || base.hooks.afterToolCall !== undefined
}

/** Validates a gated call and invokes its pre-execution plugin hook once. */
export async function prepareToolCall(
  base: ToolLoopBase,
  call: ExecutableToolCall,
): Promise<ToolCallPreparation> {
  if (!hasToolCallHooks(base)) return { kind: 'ready', prepared: { call } }
  const snapshot = base.core.tools.loadSchema(call.name)
  if (!snapshot) return { kind: 'rejected', result: { ok: false, error: `unknown tool: ${call.name}` } }
  if (
    call.registrationVersion !== undefined &&
    call.registrationVersion !== snapshot.registrationVersion
  ) {
    return {
      kind: 'rejected',
      result: {
        ok: false,
        error:
          `tool registration version mismatch: ${call.name} ` +
          `(expected ${call.registrationVersion}, current ${snapshot.registrationVersion})`,
      },
    }
  }
  let parsed: ReturnType<typeof validateAgainstSchema<Record<string, unknown>>>
  try {
    parsed = validateAgainstSchema<Record<string, unknown>>(snapshot.inputSchema, call.args)
  } catch (error) {
    return { kind: 'rejected', result: { ok: false, error: safeErrorMessage(error) } }
  }
  if (!parsed.ok) return { kind: 'rejected', result: { ok: false, error: parsed.errors.join('；') } }
  if (!isRecord(parsed.value)) {
    return { kind: 'rejected', result: { ok: false, error: '工具参数必须是对象' } }
  }
  const prepared: PreparedToolCall = {
    call: { ...call, args: parsed.value },
    ...(parsed.warnings?.length ? { schemaWarnings: parsed.warnings } : {}),
  }
  if (!base.hooks.beforeToolCall) return { kind: 'ready', prepared }
  try {
    const decision = await base.hooks.beforeToolCall(base.pluginContext, {
      callId: call.callId,
      toolName: call.name,
      args: immutableSnapshot(parsed.value),
    })
    if (decision?.block) {
      base.trace.event('agent.plugin_before_tool_call_blocked', {
        callId: call.callId,
        toolName: call.name,
        reason: decision.reason,
      })
      return {
        kind: 'rejected',
        result: {
          ok: false,
          error: decision.reason || '工具调用被插件策略阻止',
          code: 'plugin_blocked',
        },
      }
    }
    return { kind: 'ready', prepared: { ...prepared, beforeToolHookCompleted: true } }
  } catch (error) {
    base.trace.event('agent.plugin_before_tool_call_failed', {
      callId: call.callId,
      toolName: call.name,
      error: safeErrorMessage(error),
    })
    return {
      kind: 'rejected',
      result: {
        ok: false,
        error: '工具调用前置插件失败，已阻止执行',
        code: 'plugin_before_tool_call_failed',
      },
    }
  }
}

/** Executes a prepared call, then exposes only its completed result to plugins. */
export async function executePreparedToolCall(
  base: ToolLoopBase,
  prepared: PreparedToolCall,
): Promise<ToolResult> {
  const result = await executeToolCall(base, prepared.call)
  if ('pause' in result) return result
  const completed = withSchemaWarnings(result, prepared.schemaWarnings)
  if (!base.hooks.afterToolCall) return completed
  try {
    const patch = await base.hooks.afterToolCall(base.pluginContext, {
      callId: prepared.call.callId,
      toolName: prepared.call.name,
      args: immutableSnapshot(prepared.call.args as Record<string, unknown>),
      result: immutableSnapshot(completed),
    })
    return applyToolResultPatch(completed, patch)
  } catch (error) {
    base.trace.event(
      error instanceof InvalidToolResultPatchError
        ? 'agent.plugin_after_tool_call_invalid_patch'
        : 'agent.plugin_after_tool_call_failed',
      {
        callId: prepared.call.callId,
        toolName: prepared.call.name,
        error: safeErrorMessage(error),
      },
    )
    return completed
  }
}

function withSchemaWarnings(
  result: CompletedToolResult,
  schemaWarnings: string[] | undefined,
): CompletedToolResult {
  if (!result.ok || !schemaWarnings?.length) return result
  return { ...result, warnings: [...(result.warnings ?? []), ...schemaWarnings] }
}

function immutableSnapshot<T>(value: T): T {
  return freezeRecursively(structuredClone(value))
}

function freezeRecursively<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) freezeRecursively(child)
  return Object.freeze(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
