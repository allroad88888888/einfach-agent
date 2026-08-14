import type { DelegateAgentCallContext } from './types'

/** Allocates an internal id only when a legacy host has no tool-call identity. */
export function createDelegationCallIdResolver(
  runId: string,
): (context: DelegateAgentCallContext) => string {
  let legacyCallSequence = 0
  return (context) => {
    if (isNonEmptyString(context.delegationCallId)) return context.delegationCallId
    legacyCallSequence += 1
    return `legacy:${runId}:${legacyCallSequence}`
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
