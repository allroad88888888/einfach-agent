import type { AgentRolloutDriver } from '../history'
import { buildRootRolloutDelta } from '../history/rootRolloutDelta'
import type { RecoverySnapshotV1 } from '../state/recoverySnapshot.type'

export interface AgentRolloutCoordinator {
  capture(snapshot: RecoverySnapshotV1): Promise<void>
  resetSession(sessionId: string): void
  reset(): void
}

/** Serial callers bind a successfully appended root delta to the next recovery save. */
export function createAgentRolloutCoordinator(driver: AgentRolloutDriver): AgentRolloutCoordinator {
  const previousBySession = new Map<string, RecoverySnapshotV1>()

  return {
    async capture(snapshot) {
      const previous = previousBySession.get(snapshot.sessionId)
      const mutations = buildRootRolloutDelta(previous, snapshot)
      if (mutations.length > 0) {
        await driver.append(
          { kind: 'root', conversationId: snapshot.sessionId },
          mutations,
        )
      }
      previousBySession.set(snapshot.sessionId, snapshot)
    },
    resetSession(sessionId) {
      previousBySession.delete(sessionId)
    },
    reset() {
      previousBySession.clear()
    },
  }
}
