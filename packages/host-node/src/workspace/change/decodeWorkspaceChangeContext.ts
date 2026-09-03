import type { WorkspaceChangeContext } from './types'

/**
 * Decode the optional change journal context shared by every workspace mutation command.
 * The outer command uses snake_case, but the context fields intentionally remain camelCase.
 */
export function decodeWorkspaceChangeContext(
  command: string,
  value: unknown,
): WorkspaceChangeContext | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${command} 的 change_context 必须是对象`)
  }

  const context = value as Record<string, unknown>
  return {
    changeId: requiredField(command, context, 'changeId'),
    sessionId: requiredField(command, context, 'sessionId'),
    runId: requiredField(command, context, 'runId'),
    toolCallId: requiredField(command, context, 'toolCallId'),
  }
}

function requiredField(
  command: string,
  context: Record<string, unknown>,
  field: keyof WorkspaceChangeContext,
): string {
  const value = context[field]
  if (typeof value !== 'string') {
    throw new Error(`${command} 的 change_context.${field} 必须是字符串`)
  }
  return value
}
