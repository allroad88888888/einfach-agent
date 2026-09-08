// Keeps restricted capability snapshots alive for exactly as long as their reused ToolEpoch object.

import type { ToolCatalog } from '../tools/toolCatalog'
import type { ToolEpoch } from './toolEpoch'
import type { RunSkillSnapshot } from './toolContext/skillsCapabilities'
import type { RunCapabilitySnapshot } from './turnToolVisibility'

export interface RunCapabilitySnapshots {
  capabilities: RunCapabilitySnapshot
  toolCatalog: ToolCatalog
  skills: RunSkillSnapshot
}

const snapshotsByEpoch = new WeakMap<ToolEpoch, Promise<RunCapabilitySnapshots>>()

/** Reuses restricted snapshots across bootstrap resume; legacy runs intentionally remain uncached. */
export async function resolveRunCapabilitySnapshots(
  epoch: ToolEpoch | undefined,
  proposed: RunCapabilitySnapshot,
  capture: () => Promise<RunCapabilitySnapshots>,
): Promise<RunCapabilitySnapshots> {
  const cached = epoch ? snapshotsByEpoch.get(epoch) : undefined
  if (cached) return cached
  if (!epoch || proposed.state === 'legacy-unrestricted') return capture()

  const pending = capture()
  snapshotsByEpoch.set(epoch, pending)
  try {
    return await pending
  } catch (error) {
    if (snapshotsByEpoch.get(epoch) === pending) snapshotsByEpoch.delete(epoch)
    throw error
  }
}
