import {
  decodeAgentRolloutRecord,
  sameAgentHistoryTarget,
  type AgentHistoryTarget,
  type AgentRolloutDriver,
  type AgentRolloutMutationV1,
} from '@einfach-agent/core/history'

import { MAX_ROLLOUT_APPEND_BYTES, MAX_ROLLOUT_APPEND_RECORDS } from './jsonlStore'
import type { NodeHostRouteTable } from '../routeTable'

export interface AgentRolloutAppendCommandArgs {
  readonly target: AgentHistoryTarget
  readonly mutations: readonly AgentRolloutMutationV1[]
}

declare module '../commandArgs' {
  interface NodeHostCommandArgs {
    agent_rollout_append: AgentRolloutAppendCommandArgs
    agent_rollout_reconcile: Record<string, never>
  }
}

function plainObject(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${name} must be a plain object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const keys = Object.keys(value)
  if (keys.length !== expected.length || expected.some((key) => !(key in value))) {
    throw new Error(`${name} has invalid fields`)
  }
}

function decodeMutation(value: unknown, index: number): AgentRolloutMutationV1 {
  const raw = plainObject(value, `mutations[${index}]`)
  for (const key of ['schemaVersion', 'historyId', 'rolloutOrdinal', 'recordedAt']) {
    if (key in raw) throw new Error(`mutations[${index}].${key} is not allowed`)
  }
  let encoded: string
  try {
    encoded = JSON.stringify({ ...raw, schemaVersion: 1, historyId: 'command-validation',
      rolloutOrdinal: index, recordedAt: '2000-01-01T00:00:00.000Z' })
  } catch {
    throw new Error(`mutations[${index}] is not JSON serializable`)
  }
  const record = decodeAgentRolloutRecord(encoded)
  const { schemaVersion: _schema, historyId: _history, rolloutOrdinal: _ordinal,
    recordedAt: _recorded, ...mutation } = record
  return mutation
}

function validateAppend(args: Record<string, unknown>): AgentRolloutAppendCommandArgs {
  exactKeys(args, ['target', 'mutations'], 'agent_rollout_append')
  if (!Array.isArray(args.mutations) || args.mutations.length > MAX_ROLLOUT_APPEND_RECORDS) {
    throw new Error('mutations must be a bounded array')
  }
  let encoded: string
  try { encoded = JSON.stringify(args) } catch { throw new Error('rollout command is not JSON serializable') }
  if (Buffer.byteLength(encoded) > MAX_ROLLOUT_APPEND_BYTES) throw new Error('rollout command is too large')
  const mutations = args.mutations.map(decodeMutation)
  const targetProbe = decodeMutation({ mutationType: 'session_meta', target: args.target,
    title: '', createdAt: 0, updatedAt: 0 }, mutations.length).target
  for (const mutation of mutations) {
    if (!sameAgentHistoryTarget(targetProbe, mutation.target)) {
      throw new Error('mutation target does not match append target')
    }
  }
  return { target: targetProbe, mutations }
}

/** Narrows untrusted command envelopes before any rollout I/O begins. */
export function createRolloutRoutes(driver: AgentRolloutDriver): NodeHostRouteTable {
  return {
    async agent_rollout_append(args) {
      const validated = validateAppend(plainObject(args, 'agent_rollout_append'))
      return driver.append(validated.target, validated.mutations)
    },
    async agent_rollout_reconcile(args) {
      exactKeys(plainObject(args, 'agent_rollout_reconcile'), [], 'agent_rollout_reconcile')
      return driver.reconcile()
    },
  }
}
