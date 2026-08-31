import { activeSessionIdAtom, sessionsAtom } from '../../state/rootStore'
import { runAtom } from '../../state/sessionAtoms'
import type { ModelSettings, RunStatus } from '../../state/core.type'
import type { CoreInstance } from '../core/coreInstance'

export type SetActiveSessionModelSettingsResult = 'updated' | 'unchanged' | 'missing' | 'busy'

const SETTLED_RUN_STATUSES = new Set<RunStatus>(['idle', 'done', 'stopped', 'error'])

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Compares durable settings without treating key insertion order as a change. */
function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false

  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => structurallyEqual(value, right[index]))
  }

  if (!isPlainRecord(left) || !isPlainRecord(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key) && structurallyEqual(left[key], right[key]))
}

function activeRunLocksModelSettings(core: CoreInstance, sessionId: string): boolean {
  const status = core.findSessionStore(sessionId)?.store.getter(runAtom)?.status
  return status !== undefined && !SETTLED_RUN_STATUSES.has(status)
}

/** Builds the active-session model-settings mutation bound to one runtime core. */
export function createModelSettingsCommands(core: CoreInstance) {
  function setActiveSessionModelSettings(next: ModelSettings): SetActiveSessionModelSettingsResult {
    const sessionId = core.rootStore.getter(activeSessionIdAtom)
    const current = sessionId ? core.rootStore.getter(sessionsAtom)[sessionId] : undefined
    if (!current) return 'missing'
    if (activeRunLocksModelSettings(core, sessionId)) return 'busy'
    if (structurallyEqual(current.settings, next)) return 'unchanged'

    core.rootStore.setter(sessionsAtom, (sessions) => ({
      ...sessions,
      [sessionId]: { ...current, settings: next, updatedAt: Date.now() },
    }))
    core.persistence.persistSessions()
    return 'updated'
  }

  return { setActiveSessionModelSettings }
}
