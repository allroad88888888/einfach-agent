import { activeSessionIdAtom, sessionsAtom } from '../../state/rootStore'
import type { CoreInstance } from '../core/coreInstance'

/** Resolves an optional explicit session without falling back when that id is invalid. */
export function resolveSessionTarget(core: CoreInstance, sessionId?: string): string | undefined {
  const id = sessionId ?? core.rootStore.getter(activeSessionIdAtom)
  if (!id) return undefined
  if (!core.rootStore.getter(sessionsAtom)[id]) {
    if (sessionId !== undefined) throw new Error(`Unknown session: ${sessionId}`)
    return undefined
  }
  return id
}
