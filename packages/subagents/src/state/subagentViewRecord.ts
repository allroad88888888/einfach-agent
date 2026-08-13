import type { SubagentNodeStatus } from '@web-agent/core/subagents/types'

export type UnknownRecord = Record<string, unknown>

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseRecord(value: string): UnknownRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export function subagentNodeStatus(value: unknown, fallback: SubagentNodeStatus): SubagentNodeStatus {
  return value === 'queued' ||
    value === 'distilling' ||
    value === 'running' ||
    value === 'done' ||
    value === 'failed' ||
    value === 'cancelled'
    ? value
    : fallback
}
