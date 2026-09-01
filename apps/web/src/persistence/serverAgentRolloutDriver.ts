import type {
  AgentHistoryTarget,
  AgentRolloutAppendResult,
  AgentRolloutDriver,
  AgentRolloutMutationV1,
  AgentRolloutReconcileResult,
} from '@einfach-agent/core/history'
import type { HostInvoke } from '@einfach-agent/core'

import { httpInvoke } from '../host/serverInvoke'

/** Keeps corrupt source evidence from being mistaken for a recoverable projection lag. */
export function rejectSourceRolloutWarnings(reconcile: AgentRolloutReconcileResult): void {
  const source = reconcile.histories.find((history) => history.warning?.kind === 'source')?.warning
  if (source) throw new Error(`agent rollout source reconciliation failed: ${source.message}`)
  for (const history of reconcile.histories) {
    if (history.warning) console.warn('[agent-rollout]', history.warning.message)
  }
}

/** Adapts the server host-command transport to the core rollout contract. */
export function createServerAgentRolloutDriver(invoke: HostInvoke = httpInvoke): AgentRolloutDriver {
  return {
    append(
      target: AgentHistoryTarget,
      mutations: readonly AgentRolloutMutationV1[],
    ): Promise<AgentRolloutAppendResult> {
      return invoke<AgentRolloutAppendResult>('agent_rollout_append', { target, mutations })
    },
    reconcile(): Promise<AgentRolloutReconcileResult> {
      return invoke<AgentRolloutReconcileResult>('agent_rollout_reconcile', {})
    },
    async flush(): Promise<void> {
      // HTTP append calls are awaited at their durability boundary; no client queue remains to drain.
    },
  }
}
