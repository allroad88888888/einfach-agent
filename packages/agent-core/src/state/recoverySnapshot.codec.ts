// RecoverySnapshotV1 的 JSON codec 边界校验。

import {
  RECOVERY_SNAPSHOT_COMMIT_MARKER,
  RECOVERY_SNAPSHOT_SCHEMA_VERSION,
  type JsonValue,
  type RecoverySnapshotV1,
  type SubagentContinuationState,
} from './recoverySnapshot.type'

const planStatuses = new Set(['draft', 'awaiting_approval', 'approved', 'active', 'completed', 'failed', 'cancelled'])
const stageStatuses = new Set(['pending', 'in_progress', 'completed', 'failed', 'blocked', 'skipped'])
const runStatuses = new Set(['idle', 'running', 'awaiting_tool', 'waiting_user', 'waiting_confirmation', 'waiting_plan_approval', 'interrupted', 'done', 'stopped', 'error'])
const nodeTypes = new Set(['agent-batch', 'agent', 'model', 'tool', 'plan-stage', 'evaluator', 'join'])
const nodeStatuses = new Set(['queued', 'ready', 'running', 'waiting-children', 'waiting-user', 'interrupted', 'succeeded', 'failed', 'cancelled'])
const childStates = new Set<SubagentContinuationState>(['queued', 'interrupted', 'waiting_user', 'waiting_confirmation', 'waiting_plan_approval', 'outcome_unknown'])
const sessionKeys = new Set(['id', 'title', 'settings', 'createdAt', 'updatedAt', 'workspaceId', 'workspaceRoot', 'toolApprovalMode', 'loadedTools'])
const modelSettingsKeys = new Set(['vendor', 'model', 'thinking', 'temperature', 'max_tokens', 'vendorSettings'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return isFiniteJsonNumber(value)
  if (typeof value !== 'object' || ancestors.has(value)) return false
  ancestors.add(value)
  const valid = Array.isArray(value)
    ? isJsonArray(value, ancestors)
    : isJsonObject(value, ancestors)
  ancestors.delete(value)
  return valid
}

function isJsonArray(value: unknown[], ancestors: Set<object>): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || !isJsonValue(value[index], ancestors)) return false
  }
  return true
}

function isJsonObject(value: object, ancestors: Set<object>): boolean {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return typeof key === 'string'
      && descriptor?.enumerable === true
      && 'value' in (descriptor ?? {})
      && isJsonValue(descriptor?.value, ancestors)
  })
}

function isText(value: unknown): value is string {
  return typeof value === 'string'
}

function isFiniteJsonNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
}

function isNatural(value: unknown): value is number {
  return isFiniteJsonNumber(value) && Number.isSafeInteger(value) && value >= 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isText)
}

function optional(value: Record<string, unknown>, key: string, check: (entry: unknown) => boolean): boolean {
  return !(key in value) || check(value[key])
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function isModelSettings(value: unknown): boolean {
  return isRecord(value) && hasOnlyKeys(value, modelSettingsKeys)
    && isText(value.vendor) && isText(value.model)
    && optional(value, 'thinking', (entry) => typeof entry === 'boolean')
    && optional(value, 'temperature', isFiniteJsonNumber)
    && optional(value, 'max_tokens', isFiniteJsonNumber)
    && optional(value, 'vendorSettings', isRecord)
}

function isSession(value: unknown, sessionId: string): boolean {
  return isRecord(value) && hasOnlyKeys(value, sessionKeys) && value.id === sessionId
    && isText(value.title) && isModelSettings(value.settings)
    && isNatural(value.createdAt) && isNatural(value.updatedAt)
    && optional(value, 'workspaceId', isText) && optional(value, 'workspaceRoot', isText)
    && optional(value, 'toolApprovalMode', (entry) => entry === 'confirm' || entry === 'auto')
    && optional(value, 'loadedTools', isStringArray)
}

function isUserContent(value: unknown): boolean {
  return isText(value) || (Array.isArray(value) && value.every((block) => isRecord(block)
    && (block.type === 'text'
      ? isText(block.text)
      : block.type === 'image'
        && isRecord(block.source)
        && block.source.kind === 'provider-file'
        && isText(block.source.provider)
        && isText(block.source.scope)
        && isText(block.source.reference)
        && isText(block.name)
        && isText(block.mimeType)
        && isNatural(block.byteSize)
        && optional(block, 'width', isNatural)
        && optional(block, 'height', isNatural))))
}

function isToolCall(value: unknown): boolean {
  return isRecord(value) && isText(value.id) && value.type === 'function' && isRecord(value.function)
    && isText(value.function.name) && isText(value.function.arguments)
}

function isModelItem(value: unknown): boolean {
  if (!isRecord(value) || !isText(value.role)) return false
  if (value.role === 'system') return isText(value.content)
  if (value.role === 'user') return isUserContent(value.content)
  if (value.role === 'tool') return isText(value.tool_call_id) && isText(value.content)
  return value.role === 'assistant'
    && (isText(value.content) || value.content === null)
    && optional(value, 'reasoning_content', (entry) => isText(entry) || entry === null)
    && optional(value, 'tool_calls', (entry) => Array.isArray(entry) && entry.every(isToolCall))
}

function isConversationItem(value: unknown): boolean {
  return isRecord(value) && isText(value.id) && isNatural(value.createdAt) && isModelItem(value.item)
    && optional(value, 'pending', (entry) => typeof entry === 'boolean')
    && optional(value, 'planStageId', isText)
}

function isContextCheckpoint(value: unknown): boolean {
  return isRecord(value) && value.schemaVersion === 1 && isText(value.summary)
    && isStringArray(value.coveredItemIds) && isNatural(value.createdAt) && isNatural(value.sourceEstimatedTokens)
}

function isPlanStage(value: unknown): boolean {
  return isRecord(value) && isText(value.id) && isText(value.title) && isText(value.objective)
    && isStringArray(value.deliverables) && isStringArray(value.dependencies) && stageStatuses.has(value.status as string)
    && isStringArray(value.evidence) && optional(value, 'blockReason', isText)
    && optional(value, 'result', (entry) => isRecord(entry) && isText(entry.summary)
      && isStringArray(entry.evidence) && isNatural(entry.submittedAt))
}

function isPlan(value: unknown): boolean {
  return isRecord(value) && optional(value, 'schemaVersion', (entry) => entry === 4)
    && isText(value.id) && isText(value.title) && isText(value.objective) && planStatuses.has(value.status as string)
    && isNatural(value.revision) && typeof value.requiresApproval === 'boolean'
    && isNatural(value.createdAt) && isNatural(value.updatedAt)
    && Array.isArray(value.stages) && value.stages.every(isPlanStage)
}

function isPlanStageCheckpoint(value: unknown): boolean {
  return isRecord(value) && isText(value.stageId) && isPlan(value.plan)
    && isNatural(value.itemCount) && isNatural(value.createdAt)
}

function isPendingDecision(value: unknown): boolean {
  return isRecord(value) && isText(value.callId) && isJsonValue(value.payload) && isRecord(value.origin)
    && (value.origin.surface === 'conversation' || value.origin.surface === 'plan')
    && optional(value.origin, 'phase', (entry) => entry === 'drafting' || entry === 'approval' || entry === 'executing')
    && optional(value.origin, 'planId', isText) && optional(value.origin, 'planRevision', isNatural)
    && optional(value.origin, 'stageId', isText)
}

function isPendingConfirmation(value: unknown): boolean {
  return isRecord(value) && isText(value.callId) && isText(value.toolName) && isJsonValue(value.args)
    && optional(value, 'registrationVersion', isNatural) && optional(value, 'schemaWarnings', isStringArray)
    && optional(value, 'beforeToolHookCompleted', (entry) => entry === true)
    && optional(value, 'risk', (entry) => entry === 'dangerous' || entry === 'critical')
    && optional(value, 'reason', isText) && optional(value, 'irreversible', (entry) => typeof entry === 'boolean')
}

function isToolCallOutcomes(value: unknown): boolean {
  if (!isRecord(value)) return false
  return Object.entries(value).every(([callId, fact]) => isText(callId) && callId.length > 0
    && isRecord(fact) && hasOnlyKeys(fact, new Set(['state', 'updatedAt']))
    && (fact.state === 'notStarted' || fact.state === 'outcomeKnown' || fact.state === 'outcomeUnknown')
    && isNatural(fact.updatedAt))
}

function isRun(value: unknown): boolean {
  if (value === null) return true
  return isRecord(value) && !('pendingExecutionId' in value) && isText(value.runId) && runStatuses.has(value.status as string)
    && optional(value, 'startedAt', isNatural) && optional(value, 'finishedAt', isNatural) && optional(value, 'turnId', isText)
    && optional(value, 'finishReason', isText) && optional(value, 'pendingToolCalls', (entry) => Array.isArray(entry) && entry.every(isToolCall))
    && optional(value, 'toolCallOutcomes', isToolCallOutcomes)
    && optional(value, 'timedDispatchEpoch', isNatural)
    && optional(value, 'error', isText) && optional(value, 'loadedTools', isStringArray)
    && optional(value, 'pendingQuestion', isJsonValue) && optional(value, 'pendingUserDecision', isPendingDecision)
    && optional(value, 'pendingToolConfirmation', isPendingConfirmation)
    && optional(value, 'pendingPlanApproval', (entry) => isRecord(entry) && isText(entry.callId) && isText(entry.planId) && isNatural(entry.revision))
}

function isQueuedMessage(value: unknown): boolean {
  return isRecord(value) && isText(value.id) && isNatural(value.createdAt) && isUserContent(value.content)
    && isText(value.targetRunId) && optional(value, 'submissionSequence', isNatural)
}

function isAnswers(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((answer) => typeof answer === 'boolean' || isText(answer) || isStringArray(answer))
}

function isTrace(value: unknown): boolean {
  return isRecord(value) && isText(value.timestamp) && isNatural(value.turn) && isModelItem(value.item)
}

function isNode(value: unknown): boolean {
  return isRecord(value) && isText(value.id) && isText(value.graphId) && isText(value.sessionId) && isText(value.runId)
    && optional(value, 'parentId', isText) && isStringArray(value.dependsOn) && nodeTypes.has(value.type as string)
    && nodeStatuses.has(value.status as string) && isText(value.label) && isNatural(value.attempt) && isNatural(value.generation)
    && isStringArray(value.effectKeys) && isNatural(value.createdAt) && isNatural(value.updatedAt)
    && optional(value, 'startedAt', isNatural) && optional(value, 'finishedAt', isNatural)
    && optional(value, 'result', isJsonValue) && optional(value, 'error', isText)
    && optional(value, 'trace', (entry) => Array.isArray(entry) && entry.every(isTrace))
}

function isGraph(value: unknown, sessionId: string): boolean {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.nodes) || !isStringArray(value.order)) return false
  const nodes = value.nodes
  const ids = Object.keys(nodes)
  const orderedIds = new Set(value.order)
  return value.order.length === ids.length && orderedIds.size === ids.length
    && ids.every((id) => {
      const node = nodes[id]
      return orderedIds.has(id) && isRecord(node) && isNode(node) && node.id === id && node.sessionId === sessionId
        && optional(node, 'parentId', (parentId) => isText(parentId) && parentId in nodes)
        && isStringArray(node.dependsOn) && node.dependsOn.every((dependency) => dependency in nodes)
    })
}

function isSubagentContinuation(value: unknown): value is { childId: string } {
  return isRecord(value) && value.schemaVersion === 1 && isText(value.childId) && value.childId.length > 0
    && isText(value.parentRunId) && value.parentRunId.length > 0
    && (value.parentNodeId === null || (isText(value.parentNodeId) && value.parentNodeId.length > 0))
    && childStates.has(value.state as SubagentContinuationState) && isJsonValue(value.spec)
}

function isSubagentContinuations(value: unknown[]): boolean {
  const childIds = new Set<string>()
  return value.every((entry) => {
    if (!isSubagentContinuation(entry) || childIds.has(entry.childId)) return false
    childIds.add(entry.childId)
    return true
  })
}

function hasProjection(value: unknown, sessionId: string): boolean {
  if (!isRecord(value) || !isRecord(value.conversation) || !Array.isArray(value.conversation.items)
    || !('contextCheckpoint' in value.conversation) || !isRecord(value.plan) || !('current' in value.plan)
    || !Array.isArray(value.plan.stageCheckpoints) || !('run' in value) || !Array.isArray(value.queuedUserMessages)
    || !isAnswers(value.pendingQuestionAnswers) || !isGraph(value.executionGraph, sessionId)
    || !Array.isArray(value.subagentContinuations)) return false
  return value.conversation.items.every(isConversationItem)
    && (value.conversation.contextCheckpoint === null || isContextCheckpoint(value.conversation.contextCheckpoint))
    && (value.plan.current === null || isPlan(value.plan.current))
    && value.plan.stageCheckpoints.every(isPlanStageCheckpoint) && isRun(value.run)
    && value.queuedUserMessages.every(isQueuedMessage)
    && isSubagentContinuations(value.subagentContinuations)
}

/** 接受完整的 JSON-safe v1 快照；未知/半写入/损坏 envelope 一律 fail-closed。 */
export function decodeRecoverySnapshot(value: unknown): RecoverySnapshotV1 | undefined {
  const sessionId = isRecord(value) ? value.sessionId : undefined
  if (!isJsonValue(value) || !isRecord(value) || 'continuation' in value
    || value.schemaVersion !== RECOVERY_SNAPSHOT_SCHEMA_VERSION || !isText(sessionId) || sessionId.length === 0
    || !isNatural(value.capturedAt) || !isNatural(value.generation) || value.commitMarker !== RECOVERY_SNAPSHOT_COMMIT_MARKER
    || !isSession(value.session, sessionId) || !hasProjection(value.values, sessionId)) return undefined
  return value as unknown as RecoverySnapshotV1
}
