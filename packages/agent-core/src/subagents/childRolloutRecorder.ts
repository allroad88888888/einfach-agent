import type { ModelItem } from '@einfach-agent/ai'
import type {
  AgentHistoryTarget,
  AgentRolloutDriver,
  AgentRolloutMutationV1,
  AgentRunStatus,
} from '../history'

export interface ChildRolloutRecorder {
  recordInitial(items: readonly ModelItem[]): Promise<void>
  recordItem(item: ModelItem): Promise<void>
  recordSuccess(): Promise<void>
  settleFailure(status: 'failed' | 'cancelled', error: string): Promise<void>
}

interface CreateChildRolloutRecorderInput {
  driver?: AgentRolloutDriver
  conversationId: string
  runId: string
  agentPath: string
  now?: () => number
}

const terminalStatus: Record<'done' | 'failed' | 'cancelled', AgentRunStatus> = {
  done: 'done',
  failed: 'error',
  cancelled: 'stopped',
}

/** Records the exact child-model transcript at its durability boundaries. */
export function createChildRolloutRecorder(
  input: CreateChildRolloutRecorderInput,
): ChildRolloutRecorder {
  const { driver } = input
  const target: AgentHistoryTarget = {
    kind: 'child',
    conversationId: input.conversationId,
    runId: input.runId,
    agentPath: input.agentPath,
  }
  const now = input.now ?? Date.now
  let nextItemOrdinal = 0

  const append = async (mutations: readonly AgentRolloutMutationV1[]): Promise<void> => {
    if (driver) await driver.append(target, mutations)
  }
  const itemMutation = (item: ModelItem, itemOrdinal = nextItemOrdinal): AgentRolloutMutationV1 => {
    return {
      mutationType: 'item_upsert',
      target,
      itemId: `${input.runId}:${input.agentPath}:${itemOrdinal}`,
      itemOrdinal,
      createdAt: now(),
      item,
      pending: false,
      planStageId: null,
    }
  }
  const recordItem = async (item: ModelItem): Promise<void> => {
    await append([itemMutation(item)])
    nextItemOrdinal += 1
  }

  return {
    async recordInitial(items) {
      const mutations = items.map((item, index) => itemMutation(item, nextItemOrdinal + index))
      await append([
        ...mutations,
        {
          mutationType: 'run_state', target, runId: input.runId,
          turnId: null, status: 'running', error: null,
        },
      ])
      nextItemOrdinal += mutations.length
    },
    recordItem,
    async recordSuccess() {
      await append([{
        mutationType: 'run_state', target, runId: input.runId, turnId: null,
        status: terminalStatus.done, error: null,
      }])
      if (driver) await driver.flush()
    },
    async settleFailure(status, error) {
      try {
        await append([{
          mutationType: 'run_state', target, runId: input.runId, turnId: null,
          status: terminalStatus[status], error,
        }])
      } catch {
        // Preserve the execution error that caused this best-effort settlement.
      }
      try {
        if (driver) await driver.flush()
      } catch {
        // A settlement flush failure must not replace the execution error either.
      }
    },
  }
}
