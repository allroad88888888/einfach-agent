import { defaultCore } from '../runtime/core/coreInstance'
import {
  createSubagentScheduler,
  type ReserveChildrenInput,
  type SubagentScheduler,
} from './schedulerState'

export { createSubagentScheduler }
export type { ReserveChildrenInput, SubagentScheduler }

/**
 * Compatibility view for legacy callers. New work should use a CoreInstance's
 * private scheduler so independent cores never share scheduling state.
 */
export const subagentScheduler: SubagentScheduler = {
  reserveChildren(input) {
    return defaultCore.subagentScheduler.reserveChildren(input)
  },
  markNode(treeId, path, status, patch) {
    return defaultCore.subagentScheduler.markNode(treeId, path, status, patch)
  },
  snapshot(treeId) {
    return defaultCore.subagentScheduler.snapshot(treeId)
  },
  subscribe(listener) {
    return defaultCore.subagentScheduler.subscribe(listener)
  },
  clear(treeId) {
    defaultCore.subagentScheduler.clear(treeId)
  },
}
