import type { SessionMeta } from './core.type'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function positiveRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function stringRecord(value: unknown): value is Record<string, string> {
  return record(value) && Object.values(value).every((entry) => typeof entry === 'string')
}

function skillContent(value: unknown): boolean {
  return record(value)
    && exactKeys(value, ['name', 'revision', 'description', 'triggers', 'content', 'resources'])
    && typeof value.name === 'string' && value.name.length > 0
    && positiveRevision(value.revision)
    && typeof value.description === 'string'
    && Array.isArray(value.triggers) && value.triggers.every((entry) => typeof entry === 'string')
    && typeof value.content === 'string'
    && stringRecord(value.resources)
}

/** Strict persisted boundary for the immutable embedding profile. */
export function isAgentProfileSnapshot(value: unknown): value is NonNullable<SessionMeta['agentProfile']> {
  return record(value)
    && exactKeys(value, ['agentId', 'revision', 'instructions', 'connectionId', 'skillContents'])
    && typeof value.agentId === 'string' && value.agentId.length > 0
    && positiveRevision(value.revision)
    && typeof value.instructions === 'string'
    && typeof value.connectionId === 'string' && value.connectionId.length > 0
    && Array.isArray(value.skillContents) && value.skillContents.every(skillContent)
}
