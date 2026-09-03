import type { JsonValue, SubagentContinuationV1 } from '../state/recoverySnapshot.type'
import {
  isDelegatableDangerousTool,
  type DelegatableDangerousTool,
} from '../runtime/dangerousTools'
import { ROOT_AGENT_PATH, isAgentPath, parentAgentPath } from './path'
import { SUBAGENT_TOOL_PROFILES } from './toolProfile'
import {
  SUBAGENT_MODEL_TIERS,
  SUBAGENT_RISK_LEVELS,
  SUBAGENT_TASK_CATEGORIES,
} from './types'
import type {
  ChildContinuationDescriptor,
  ChildContinuationRecoveryDisposition,
  ChildTaskSnapshot,
} from './continuationDescriptor'

/** Parses only valid JSON continuation descriptors before recovery can inspect their intent. */
export function parseChildContinuation(
  continuation: SubagentContinuationV1,
): ChildContinuationRecoveryDisposition {
  const descriptor = readChildContinuationDescriptor(continuation)
  if (!descriptor) return { kind: 'requires_reconciliation', reason: 'invalid child descriptor' }
  if (descriptor.lifecycle === 'terminal') return { kind: 'deliver_terminal' }
  if (continuation.state === 'waiting_user' || continuation.state === 'waiting_confirmation'
    || continuation.state === 'waiting_plan_approval') return { kind: 'await_input' }
  return { kind: 'requires_reconciliation', reason: 'child execution requires reconciliation' }
}

/** Validates version, lineage, task input and nested child ids without admitting runnable work. */
export function readChildContinuationDescriptor(
  continuation: SubagentContinuationV1,
): ChildContinuationDescriptor | undefined {
  if (continuation.schemaVersion !== 1 || !nonEmpty(continuation.childId) || !nonEmpty(continuation.parentRunId)) return undefined
  const descriptor = parseDescriptor(continuation.spec)
  if (!descriptor) return undefined
  const childPath = continuation.childId.slice(`${continuation.parentRunId}:`.length)
  if (continuation.childId !== `${continuation.parentRunId}:${childPath}` || !isAgentPath(childPath)
    || parentAgentPath(childPath) !== descriptor.parent.path) return undefined
  const expectedParentNodeId = descriptor.parent.path === ROOT_AGENT_PATH ? null : `${continuation.parentRunId}:${descriptor.parent.path}`
  if (continuation.parentNodeId !== expectedParentNodeId
    || !onlyDirectNested(descriptor.nestedChildIds, continuation.parentRunId, childPath)
    || (descriptor.lifecycle === 'terminal' && continuation.state !== 'interrupted')) return undefined
  return descriptor
}

function parseDescriptor(value: JsonValue): ChildContinuationDescriptor | undefined {
  if (!record(value) || value.version !== 1 || value.resumePolicy !== 'requires_reconciliation') return undefined
  const parent = readParent(value.parent)
  const task = readTask(value.task)
  const nestedChildIds = stringArray(value.nestedChildIds)
  const knownToolOutcome = readOutcome(value.knownToolOutcome)
  if (!parent || !task || !nestedChildIds || !knownToolOutcome) return undefined
  if (value.lifecycle === 'active' && exactKeys(value, [
    'version', 'parent', 'task', 'lifecycle', 'resumePolicy', 'knownToolOutcome', 'nestedChildIds',
  ])) {
    return { version: 1, parent, task, lifecycle: 'active', resumePolicy: 'requires_reconciliation', knownToolOutcome, nestedChildIds }
  }
  const terminal = value.lifecycle === 'terminal' ? readTerminal(value.terminal) : undefined
  return terminal && knownToolOutcome.kind === 'unknown' && exactKeys(value, [
    'version', 'parent', 'task', 'lifecycle', 'resumePolicy', 'knownToolOutcome', 'nestedChildIds', 'terminal',
  ])
    ? { version: 1, parent, task, lifecycle: 'terminal', resumePolicy: 'requires_reconciliation', knownToolOutcome, nestedChildIds, terminal }
    : undefined
}

function readParent(value: JsonValue | undefined): ChildContinuationDescriptor['parent'] | undefined {
  if (!record(value) || !exactKeys(value, ['path', 'delegationCallId'])
    || typeof value.path !== 'string' || !isAgentPath(value.path) || !nonEmpty(value.delegationCallId)) return undefined
  return { path: value.path, delegationCallId: value.delegationCallId }
}

function readTask(value: JsonValue | undefined): ChildTaskSnapshot | undefined {
  if (!record(value) || !onlyKnownKeys(value, [
    'objective', 'mode', 'expectedOutput', 'modelTier', 'taskCategory', 'riskLevel', 'crossModule',
    'requiresTemporalNormalization', 'finalAcceptance', 'priorFailureCount', 'maxDepth', 'maxChildren',
    'maxTurns', 'toolProfile', 'confirmedTools',
  ]) || !nonEmpty(value.objective)) return undefined
  const mode = optionalString(value.mode)
  const expectedOutput = optionalString(value.expectedOutput)
  const modelTier = optionalOneOf(value.modelTier, SUBAGENT_MODEL_TIERS)
  const taskCategory = optionalOneOf(value.taskCategory, SUBAGENT_TASK_CATEGORIES)
  const riskLevel = optionalOneOf(value.riskLevel, SUBAGENT_RISK_LEVELS)
  const crossModule = optionalBoolean(value.crossModule)
  const requiresTemporalNormalization = optionalBoolean(value.requiresTemporalNormalization)
  const finalAcceptance = optionalBoolean(value.finalAcceptance)
  const priorFailureCount = optionalFinite(value.priorFailureCount)
  const maxDepth = optionalFinite(value.maxDepth)
  const maxChildren = optionalFinite(value.maxChildren)
  const maxTurns = optionalFinite(value.maxTurns)
  const toolProfile = optionalOneOf(value.toolProfile, SUBAGENT_TOOL_PROFILES)
  const confirmedTools = value.confirmedTools === undefined
    ? undefined
    : delegatableDangerousToolArray(value.confirmedTools)
  if ((value.mode !== undefined && mode === undefined) || (value.expectedOutput !== undefined && expectedOutput === undefined)
    || (value.modelTier !== undefined && modelTier === undefined) || (value.taskCategory !== undefined && taskCategory === undefined)
    || (value.riskLevel !== undefined && riskLevel === undefined) || (value.crossModule !== undefined && crossModule === undefined)
    || (value.requiresTemporalNormalization !== undefined && requiresTemporalNormalization === undefined)
    || (value.finalAcceptance !== undefined && finalAcceptance === undefined)
    || (value.priorFailureCount !== undefined && priorFailureCount === undefined) || (value.maxDepth !== undefined && maxDepth === undefined)
    || (value.maxChildren !== undefined && maxChildren === undefined) || (value.maxTurns !== undefined && maxTurns === undefined)
    || (value.toolProfile !== undefined && toolProfile === undefined)
    || (value.confirmedTools !== undefined && confirmedTools === undefined)) return undefined
  return {
    objective: value.objective,
    ...(mode === undefined ? {} : { mode }),
    ...(expectedOutput === undefined ? {} : { expectedOutput }),
    ...(modelTier === undefined ? {} : { modelTier }),
    ...(taskCategory === undefined ? {} : { taskCategory }),
    ...(riskLevel === undefined ? {} : { riskLevel }),
    ...(crossModule === undefined ? {} : { crossModule }),
    ...(requiresTemporalNormalization === undefined ? {} : { requiresTemporalNormalization }),
    ...(finalAcceptance === undefined ? {} : { finalAcceptance }),
    ...(priorFailureCount === undefined ? {} : { priorFailureCount }),
    ...(maxDepth === undefined ? {} : { maxDepth }),
    ...(maxChildren === undefined ? {} : { maxChildren }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(toolProfile === undefined ? {} : { toolProfile }),
    ...(confirmedTools === undefined ? {} : { confirmedTools }),
  }
}

function readTerminal(value: JsonValue | undefined): NonNullable<ChildContinuationDescriptor['terminal']> | undefined {
  if (!record(value) || !exactKeys(value, ['kind', 'summary', 'resultArchivePath', 'deliverables'])
    || (value.kind !== 'done' && value.kind !== 'failed' && value.kind !== 'cancelled')
    || typeof value.summary !== 'string' || (typeof value.resultArchivePath !== 'string' && value.resultArchivePath !== null)
    || !record(value.deliverables) || !exactKeys(value.deliverables, ['skillFiles', 'skillIds', 'changeSets'])) return undefined
  const skillFiles = stringArray(value.deliverables.skillFiles)
  const skillIds = stringArray(value.deliverables.skillIds)
  const changeSets = readChangeSets(value.deliverables.changeSets)
  if (!skillFiles || !skillIds || !changeSets) return undefined
  return {
    kind: value.kind,
    summary: value.summary,
    resultArchivePath: value.resultArchivePath,
    deliverables: {
      skillFiles,
      skillIds,
      changeSets,
    },
  }
}

function readOutcome(value: JsonValue | undefined): ChildContinuationDescriptor['knownToolOutcome'] | undefined {
  if (!record(value)) return undefined
  if (value.kind === 'none' && exactKeys(value, ['kind'])) return { kind: 'none' }
  return value.kind === 'unknown' && nonEmpty(value.reason) && exactKeys(value, ['kind', 'reason'])
    ? { kind: 'unknown', reason: value.reason }
    : undefined
}

function onlyDirectNested(ids: readonly string[], runId: string, parentPath: string): boolean {
  return new Set(ids).size === ids.length && ids.every((id) => {
    const path = id.slice(`${runId}:`.length)
    return id === `${runId}:${path}` && isAgentPath(path) && parentAgentPath(path) === parentPath
  })
}

function record(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: JsonValue | undefined): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? [...value] : undefined
}

function delegatableDangerousToolArray(
  value: JsonValue | undefined,
): DelegatableDangerousTool[] | undefined {
  return Array.isArray(value)
    && value.every((entry): entry is DelegatableDangerousTool => (
      typeof entry === 'string' && isDelegatableDangerousTool(entry)
    ))
    ? [...value]
    : undefined
}

function readChangeSets(value: JsonValue | undefined): Array<{ id: string; reversible: boolean }> | undefined {
  if (!Array.isArray(value)) return undefined
  const result: Array<{ id: string; reversible: boolean }> = []
  for (const item of value) {
    if (!record(item) || !exactKeys(item, ['id', 'reversible'])
      || !nonEmpty(item.id) || typeof item.reversible !== 'boolean') return undefined
    result.push({ id: item.id, reversible: item.reversible })
  }
  return result
}

function exactKeys(value: Record<string, JsonValue>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && onlyKnownKeys(value, expected)
}

function onlyKnownKeys(value: Record<string, JsonValue>, known: readonly string[]): boolean {
  return Object.keys(value).every((key) => known.includes(key))
}

function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalBoolean(value: JsonValue | undefined): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function optionalFinite(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalOneOf<T extends string>(value: JsonValue | undefined, options: readonly T[]): T | undefined {
  return typeof value === 'string' && oneOf(value, options) ? value : undefined
}

function oneOf<T extends string>(value: string, options: readonly T[]): value is T {
  return options.some((option) => option === value)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
