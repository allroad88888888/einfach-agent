import type { AgentHistoryTarget } from './agentHistoryTarget'
import type { AgentRolloutMutationV1, AgentRunStateMutationV1 } from './rolloutMutation'
import type { ConversationItem } from '../state/core.type'
import type { RecoverySnapshotV1 } from '../state/recoverySnapshot.type'

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`
  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`
}

function target(snapshot: RecoverySnapshotV1): AgentHistoryTarget {
  return { kind: 'root', conversationId: snapshot.sessionId }
}

function sessionMeta(snapshot: RecoverySnapshotV1, historyTarget: AgentHistoryTarget): AgentRolloutMutationV1 {
  const { title, createdAt, updatedAt } = snapshot.session
  return { mutationType: 'session_meta', target: historyTarget, title, createdAt, updatedAt }
}

function turnContext(snapshot: RecoverySnapshotV1, historyTarget: AgentHistoryTarget): AgentRolloutMutationV1 {
  return {
    mutationType: 'turn_context',
    target: historyTarget,
    turnId: snapshot.values.run?.turnId ?? null,
    itemIds: snapshot.values.conversation.items.map(({ id }) => id),
  }
}

function runState(snapshot: RecoverySnapshotV1, historyTarget: AgentHistoryTarget): AgentRunStateMutationV1 {
  const run = snapshot.values.run
  return {
    mutationType: 'run_state',
    target: historyTarget,
    runId: run?.runId ?? null,
    turnId: run?.turnId ?? null,
    status: run?.status ?? 'idle',
    error: run?.error ?? null,
  }
}

function itemUpsert(
  item: ConversationItem,
  itemOrdinal: number,
  historyTarget: AgentHistoryTarget,
): AgentRolloutMutationV1 {
  return {
    mutationType: 'item_upsert',
    target: historyTarget,
    itemId: item.id,
    itemOrdinal,
    createdAt: item.createdAt,
    item: item.item,
    pending: item.pending ?? false,
    planStageId: item.planStageId ?? null,
  }
}

function changed(left: unknown, right: unknown): boolean {
  return stableJson(left) !== stableJson(right)
}

/**
 * Produces the representable root-history changes between two recovery captures.
 * The recovery snapshots remain untouched; all output ordering is deterministic.
 */
export function buildRootRolloutDelta(
  previous: RecoverySnapshotV1 | undefined,
  current: RecoverySnapshotV1,
): readonly AgentRolloutMutationV1[] {
  if (previous !== undefined && previous.sessionId !== current.sessionId) {
    throw new Error('Cannot build a root rollout delta across sessions')
  }
  const historyTarget = target(current)
  const mutations: AgentRolloutMutationV1[] = []
  const previousTarget = previous === undefined ? undefined : target(previous)
  const currentMeta = sessionMeta(current, historyTarget)
  const currentContext = turnContext(current, historyTarget)

  if (previous === undefined || changed(sessionMeta(previous, previousTarget!), currentMeta)) mutations.push(currentMeta)
  if (previous === undefined || changed(turnContext(previous, previousTarget!), currentContext)) mutations.push(currentContext)

  const priorItems = new Map(previous?.values.conversation.items.map((item, index) => [item.id, { item, index }]))
  const currentIds = new Set(current.values.conversation.items.map(({ id }) => id))
  for (const [itemOrdinal, item] of current.values.conversation.items.entries()) {
    const prior = priorItems.get(item.id)
    const next = itemUpsert(item, itemOrdinal, historyTarget)
    if (prior === undefined || prior.index !== itemOrdinal || changed(itemUpsert(prior.item, prior.index, historyTarget), next)) {
      mutations.push(next)
    }
  }
  if (previous !== undefined) {
    for (const item of previous.values.conversation.items) {
      if (!currentIds.has(item.id)) {
        mutations.push({ mutationType: 'item_deleted', target: historyTarget, itemId: item.id, reason: 'deleted' })
      }
    }
  }

  const currentRun = runState(current, historyTarget)
  if (previous === undefined || changed(runState(previous, previousTarget!), currentRun)) mutations.push(currentRun)
  return mutations
}
