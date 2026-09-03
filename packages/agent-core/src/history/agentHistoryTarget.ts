export type AgentHistoryTarget =
  | { readonly kind: 'root'; readonly conversationId: string }
  | {
      readonly kind: 'child'
      readonly conversationId: string
      readonly runId: string
      readonly agentPath: string
    }

export type AgentHistoryTargetField = 'conversationId' | 'runId' | 'agentPath'
export type AgentHistoryTargetStringDecoder = (value: unknown, field: AgentHistoryTargetField) => string

export interface AgentHistoryTargetIdentity {
  readonly kind: AgentHistoryTarget['kind']
  readonly conversationId: string
  readonly runId: string | null
  readonly agentPath: string | null
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Agent history target must be an object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Agent history target must be a plain object')
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const missing = expected.find(key => !Object.hasOwn(value, key))
  if (missing) throw new TypeError(`Agent history target ${missing} is required`)
  const extra = Object.keys(value).find(key => !expected.includes(key))
  if (extra) throw new TypeError(`Agent history target ${extra} is not allowed`)
}

function nonemptyString(value: unknown, field: AgentHistoryTargetField): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`Agent history target ${field} must be a non-empty string`)
  }
  return value
}

export function decodeAgentHistoryTarget(
  value: unknown,
  decodeString: AgentHistoryTargetStringDecoder = nonemptyString,
): AgentHistoryTarget {
  const candidate = object(value)
  if (candidate.kind === 'root') {
    exactKeys(candidate, ['kind', 'conversationId'])
    return { kind: 'root', conversationId: decodeString(candidate.conversationId, 'conversationId') }
  }
  if (candidate.kind === 'child') {
    exactKeys(candidate, ['kind', 'conversationId', 'runId', 'agentPath'])
    return {
      kind: 'child',
      conversationId: decodeString(candidate.conversationId, 'conversationId'),
      runId: decodeString(candidate.runId, 'runId'),
      agentPath: decodeString(candidate.agentPath, 'agentPath'),
    }
  }
  throw new TypeError('Agent history target kind must be root or child')
}

export function agentHistoryTargetIdentity(target: AgentHistoryTarget): AgentHistoryTargetIdentity {
  return target.kind === 'root'
    ? { kind: 'root', conversationId: target.conversationId, runId: null, agentPath: null }
    : { kind: 'child', conversationId: target.conversationId, runId: target.runId, agentPath: target.agentPath }
}

export function decodeAgentHistoryTargetIdentity(value: unknown): AgentHistoryTarget {
  const identity = object(value)
  exactKeys(identity, ['kind', 'conversationId', 'runId', 'agentPath'])
  if (identity.kind === 'root' && identity.runId === null && identity.agentPath === null) {
    return decodeAgentHistoryTarget({ kind: identity.kind, conversationId: identity.conversationId })
  }
  if (identity.kind === 'child') {
    return decodeAgentHistoryTarget(identity)
  }
  throw new TypeError('Agent history target identity is invalid')
}

export function agentHistoryTargetKey(target: AgentHistoryTarget): string {
  const identity = agentHistoryTargetIdentity(target)
  return JSON.stringify([identity.kind, identity.conversationId, identity.runId, identity.agentPath])
}

export function sameAgentHistoryTarget(left: AgentHistoryTarget, right: AgentHistoryTarget): boolean {
  return agentHistoryTargetKey(left) === agentHistoryTargetKey(right)
}

export function agentHistoryTargetJsonSchema(maxStringLength?: number): Readonly<Record<string, unknown>> {
  const text = { type: 'string', minLength: 1, ...(maxStringLength === undefined ? {} : { maxLength: maxStringLength }) }
  return {
    oneOf: [
      { type: 'object', additionalProperties: false,
        properties: { kind: { const: 'root' }, conversationId: text },
        required: ['kind', 'conversationId'] },
      { type: 'object', additionalProperties: false,
        properties: { kind: { const: 'child' }, conversationId: text, runId: text, agentPath: text },
        required: ['kind', 'conversationId', 'runId', 'agentPath'] },
    ],
  }
}
