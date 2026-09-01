import { dirname } from 'node:path'
import {
  createNodeAgentRolloutDriver,
  createNodeSqlExecutorLoader,
} from '@einfach-agent/host-node'
import {
  configureSqlExecutor,
  createSqliteHistoryLogDriver,
  createSqliteRecoveryDriver,
} from '@einfach-agent/persistence-sqlite'
import type { AgentRolloutDriver, AgentRolloutReconcileResult } from '@einfach-agent/core/history'
import type { AgentHistoryCapabilityProvider } from '@einfach-agent/core/history'
import type { CoreInstance } from '@einfach-agent/core'
import { createCliAgentHistoryProvider } from './historyCapability'

export type CliPersistenceCore = Pick<CoreInstance, 'persistence' | 'findSessionStore'>

export interface CliPersistenceOptions {
  readonly databasePath: string
  readonly homeDir: string
  readonly agentRolloutDriver?: AgentRolloutDriver
}

export interface CliPersistenceAssembly {
  readonly agentRollout: AgentRolloutDriver
  readonly agentHistory: AgentHistoryCapabilityProvider
  reconcile(): Promise<AgentRolloutReconcileResult>
  flush(): Promise<void>
}

function sourceWarning(result: AgentRolloutReconcileResult): string | undefined {
  return result.histories.find((history) => history.warning?.kind === 'source')?.warning?.message
}

/** Connects CLI root recovery and child recording to one direct Node rollout driver. */
export async function assembleCliPersistence(
  core: CliPersistenceCore,
  options: CliPersistenceOptions,
): Promise<CliPersistenceAssembly> {
  const sqliteOptions = { homeDir: options.homeDir, databasePath: options.databasePath }
  const executorLoader = createNodeSqlExecutorLoader(sqliteOptions, 'persistence')
  configureSqlExecutor(executorLoader)
  const executor = await executorLoader()
  const agentRollout = options.agentRolloutDriver ?? createNodeAgentRolloutDriver({
    appDataDirectory: dirname(options.databasePath),
    executor,
  })
  const recovery = createSqliteRecoveryDriver()
  const agentHistory = createCliAgentHistoryProvider({ executor, agentRollout, recovery })
  core.persistence.configure({
    recovery,
    historyLog: createSqliteHistoryLogDriver(),
    recoveryStore: (sessionId) => core.findSessionStore(sessionId)?.store,
    historyFor: (sessionId) => core.findSessionStore(sessionId)?.history,
    agentRollout,
    agentHistory,
  })

  return {
    agentRollout,
    agentHistory,
    async reconcile(): Promise<AgentRolloutReconcileResult> {
      const result = await agentRollout.reconcile()
      const fatal = sourceWarning(result)
      if (fatal) throw new Error(`agent rollout source reconciliation failed: ${fatal}`)
      for (const history of result.histories) {
        if (history.warning) console.warn('[agent-rollout]', history.warning.message)
      }
      return result
    },
    async flush(): Promise<void> {
      await core.persistence.flushRecovery()
      await agentRollout.flush()
    },
  }
}
