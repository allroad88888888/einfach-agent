import type { Store } from '@einfach/core'
import { sessionsAtom } from '../../state/rootStore'
import { runAtom } from '../../state/sessionAtoms'

export interface CurrentRunDeps {
  root: Store
  getStore: () => Store
  sessionId: string
  runId: string
}

/** Returns whether the session still owns the given run. */
export function isCurrentRun(deps: CurrentRunDeps): boolean {
  if (!deps.root.getter(sessionsAtom)[deps.sessionId]) return false
  return deps.getStore().getter(runAtom)?.runId === deps.runId
}
