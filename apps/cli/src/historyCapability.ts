import type { AgentHistoryCapabilityProvider, AgentRolloutDriver } from '@einfach-agent/core/history'
import type { RecoveryDriver, SqlExecutor } from '@einfach-agent/core/state/persistence'
import { createNodeAgentHistoryProvider } from '@einfach-agent/host-node'

/** Creates the CLI history provider from its already-owned persistence identities. */
export function createCliAgentHistoryProvider(input: {
  readonly executor: SqlExecutor
  readonly agentRollout: AgentRolloutDriver
  readonly recovery: Pick<RecoveryDriver, 'listLatest'>
}): AgentHistoryCapabilityProvider {
  return createNodeAgentHistoryProvider(input)
}
