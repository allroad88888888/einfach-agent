import type { ModelFunctionTool } from '@einfach-agent/ai'
import type { LoadedTool } from '../tools/types'
import { toolSchemaAutoloadedResult } from '../tools/schemaResult'
import { toolRegistrationChangedResult } from './toolLoading'

/**
 * Shared ordering for tool-call gates. The child loop uses it now; modelRun
 * deliberately keeps its inline implementation until R7 moves it here.
 */
export const REQUEST_TOOL_SCHEMA_NAME = 'request_tool_schema'

export type ToolGateDecision
  = | { kind: 'schema_request'; toolName: string }
    | { kind: 'schema_request_denied'; toolName: string; result: Record<string, unknown> }
    | { kind: 'schema_autoloaded'; tool: LoadedTool; result: Record<string, unknown> }
    | { kind: 'registration_changed'; result: Record<string, unknown> }
    | { kind: 'delegate' }
    | { kind: 'delegate_depth_reached'; result: Record<string, unknown> }
    | { kind: 'execute' }
    | { kind: 'tool_not_allowed'; result: Record<string, unknown> }

export interface ToolGateInput {
  name: string
  args: Record<string, unknown>
  turnTools: readonly ModelFunctionTool[]
  isSynthesisTurn: boolean
  isAllowedTool(name: string): boolean
  loadSchema(name: string): LoadedTool | undefined
  expectedRegistrationVersion: number | undefined
  registrationVersion(name: string): number | undefined
  canExecuteTool(name: string): boolean
  delegate: {
    name: string
    path: string
    depth: number
    maxDepth: number
  }
}

function requestedToolName(args: Record<string, unknown>): string {
  return typeof args.toolName === 'string' ? args.toolName.trim() : ''
}

function isExposedTool(name: string, turnTools: readonly ModelFunctionTool[]): boolean {
  return turnTools.some((tool) => tool.function.name === name)
}

function toolNotAllowedResult(name: string): Record<string, unknown> {
  return { error: `tool not allowed for child agent: ${name}` }
}

/**
 * Select the first matching tool gate, in the same order as the main loop.
 *
 * The callbacks keep this module independent of a particular registry or
 * tool-profile implementation, so the root loop can adopt it without taking
 * a dependency on subagent runtime code.
 */
export function selectToolGate(input: ToolGateInput): ToolGateDecision {
  const isAllowed = input.isAllowedTool(input.name)

  if (input.name === REQUEST_TOOL_SCHEMA_NAME) {
    const toolName = requestedToolName(input.args)
    if (toolName && !input.isAllowedTool(toolName)) {
      return {
        kind: 'schema_request_denied',
        toolName,
        result: toolNotAllowedResult(toolName),
      }
    }
    return { kind: 'schema_request', toolName }
  }

  // A tool omitted from this request must never execute from guessed args.
  // The synthesis turn intentionally has no tools, so it cannot auto-load.
  if (!input.isSynthesisTurn && isAllowed && !isExposedTool(input.name, input.turnTools)) {
    const tool = input.loadSchema(input.name)
    if (tool) {
      return {
        kind: 'schema_autoloaded',
        tool,
        result: toolSchemaAutoloadedResult(tool),
      }
    }
  }

  if (isAllowed && isExposedTool(input.name, input.turnTools)) {
    const currentRegistrationVersion = input.registrationVersion(input.name)
    if (
      input.expectedRegistrationVersion === undefined
      || input.expectedRegistrationVersion !== currentRegistrationVersion
    ) {
      return {
        kind: 'registration_changed',
        result: toolRegistrationChangedResult(
          input.name,
          input.expectedRegistrationVersion,
          currentRegistrationVersion,
        ),
      }
    }
  }

  if (input.name === input.delegate.name) {
    if (input.delegate.depth >= input.delegate.maxDepth) {
      return {
        kind: 'delegate_depth_reached',
        result: { error: `max subagent depth reached at ${input.delegate.path}` },
      }
    }
    return { kind: 'delegate' }
  }

  if (isAllowed && input.canExecuteTool(input.name)) return { kind: 'execute' }
  return { kind: 'tool_not_allowed', result: toolNotAllowedResult(input.name) }
}
