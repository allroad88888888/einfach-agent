import { defaultCore } from '../runtime/core/coreInstance'
import type { ReserveChildrenInput, SubagentScheduler } from '../runtime/delegationContract'

export type { ReserveChildrenInput, SubagentScheduler }

function defaultScheduler(): SubagentScheduler {
  const scheduler = defaultCore.delegation?.scheduler
  if (!scheduler) throw new Error('默认 Core 未注入子 Agent 委派能力')
  return scheduler
}

/**
 * Compatibility view for legacy callers. New work should use a CoreInstance's
 * private scheduler so independent cores never share scheduling state.
 */
export const subagentScheduler: SubagentScheduler = {
  reserveChildren(input) {
    return defaultScheduler().reserveChildren(input)
  },
  markNode(treeId, path, status, patch) {
    return defaultScheduler().markNode(treeId, path, status, patch)
  },
  snapshot(treeId) {
    return defaultScheduler().snapshot(treeId)
  },
  subscribe(listener) {
    return defaultScheduler().subscribe(listener)
  },
  clear(treeId) {
    defaultScheduler().clear(treeId)
  },
}
