import { runAtom } from '../state/sessionAtoms'
import { patchRun } from '../state/sessionWriters'
import type { ToolLoopBase } from './toolLoopContracts'

/** Reads or allocates the durable ordinal for the current logical model request. */
export function ensureTimedDispatchEpoch(base: ToolLoopBase): number {
  const run = base.core.getSessionStore(base.id).store.getter(runAtom)
  const epoch = run?.timedDispatchEpoch
  if (epoch !== undefined) return epoch
  if (run) patchRun(base.id, { timedDispatchEpoch: 0 }, base.core)
  return 0
}

/** Advances the ordinal only after the current model response is ready to persist. */
export function advanceTimedDispatchEpoch(base: ToolLoopBase): number {
  const next = ensureTimedDispatchEpoch(base) + 1
  patchRun(base.id, { timedDispatchEpoch: next }, base.core)
  return next
}
