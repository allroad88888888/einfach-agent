import type {
  ChildAgentResult,
  SubagentArchiveEvent,
  SubagentArchiveEventType,
  SubagentNodeRecord,
} from './types'
import {
  parseJsonDocument,
  parseJsonl,
  type JsonlParseError as ParseError,
  type JsonlParseResult,
} from './jsonl'
import { compareAgentPaths, parseAgentPath } from './path'

export type { JsonlParseError as ParseError, JsonlParseResult } from './jsonl'

// 与 types.ts 的 SubagentArchiveEventType 联合一一对应 —— 漏一个，该类事件就会被
// isSubagentArchiveEvent 判为结构非法而落进 parseErrors，eventCounts 也不再统计它。
// 用 Record 而非数组字面量：数组类型允许子集，漏写不会报错；Record 少一个键编译期就失败，
// 多一个键也会被拒。scripts/subagent-replay-lib.js 里的同名白名单由该文件的测试锁步校验。
const SUBAGENT_EVENT_TYPE_SET: Record<SubagentArchiveEventType, true> = {
  archive_initialized: true,
  delegate_requested: true,
  children_reserved: true,
  skill_written: true,
  child_started: true,
  child_tool_schema_requested: true,
  child_tool_finished: true,
  nested_delegate_requested: true,
  child_finished: true,
  tree_snapshot_written: true,
  delegate_finished: true,
  child_model_usage: true,
  child_model_escalated: true,
  child_context_distillation_started: true,
  child_context_distillation_succeeded: true,
  child_context_distillation_failed: true,
}

export const SUBAGENT_EVENT_TYPES = Object.keys(
  SUBAGENT_EVENT_TYPE_SET,
) as SubagentArchiveEventType[]

const ROOT_AGENT_PATH = 'root'

export interface SubagentTreeSnapshot {
  nodes: SubagentNodeRecord[]
}

export interface SubagentReplayState {
  conversationId: string
  runId: string
  treeId: string
  eventCounts: Record<SubagentArchiveEventType, number>
  events: SubagentArchiveEvent[]
  parseErrors: ParseError[]
  nodes: Record<string, SubagentNodeRecord>
  orderedPaths: string[]
  childResults: ChildAgentResult[]
  summary: {
    total: number
    running: number
    distilling: number
    queued: number
    done: number
    failed: number
    cancelled: number
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isSubagentArchiveEventType(value: unknown): value is SubagentArchiveEventType {
  return isString(value) && SUBAGENT_EVENT_TYPES.includes(value as SubagentArchiveEventType)
}

function isSubagentArchiveEvent(value: unknown): value is SubagentArchiveEvent {
  if (!isRecord(value)) return false
  if (!isString(value.eventId)) return false
  if (!isString(value.timestamp)) return false
  if (!isString(value.conversationId)) return false
  if (!isString(value.runId)) return false
  if (!isString(value.treeId)) return false
  if (!isString(value.agentPath)) return false
  if (!isSubagentArchiveEventType(value.type)) return false
  return value.data === undefined || isRecord(value.data)
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => isString(item)) ? (value as string[]) : undefined
}

function asStringOrUndefined(value: unknown): string | undefined {
  return isString(value) ? value : undefined
}

function inferTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!isString(value)) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function cloneNode(node: SubagentNodeRecord): SubagentNodeRecord {
  return {
    ...node,
    inheritedSkillFiles: [...node.inheritedSkillFiles],
    inheritedSkillIds: [...node.inheritedSkillIds],
    localSkillFiles: [...node.localSkillFiles],
    localSkillIds: [...node.localSkillIds],
  }
}

function normalizeNodeFromSnapshot(record: Record<string, unknown>): SubagentNodeRecord | null {
  const path = asStringOrUndefined(record.path)
  if (!path) return null

  const status = (() => {
    const value = asStringOrUndefined(record.status)
    return value === 'running' || value === 'distilling' || value === 'done' || value === 'failed' || value === 'cancelled'
      ? value
      : 'queued'
  })()

  const createdAt = inferTimestamp(record.createdAt) ?? Date.now()
  const updatedAt = inferTimestamp(record.updatedAt) ?? createdAt

  return {
    id: asStringOrUndefined(record.id) ?? `${asStringOrUndefined(record.treeId) ?? ''}:${path}`,
    treeId: asStringOrUndefined(record.treeId) ?? '',
    sessionId: asStringOrUndefined(record.sessionId) ?? '',
    path,
    parentPath: asStringOrUndefined(record.parentPath) ?? (path === ROOT_AGENT_PATH ? undefined : resolveParentPath(path)),
    status,
    objective: asStringOrUndefined(record.objective) ?? (path === ROOT_AGENT_PATH ? 'root agent' : `agent ${path}`),
    mode: asStringOrUndefined(record.mode),
    expectedOutput: asStringOrUndefined(record.expectedOutput),
    depth: typeof record.depth === 'number' && Number.isFinite(record.depth)
      ? Math.max(0, Math.floor(record.depth))
      : (parseAgentPath(path)?.length ?? 0),
    dispatchCounter: typeof record.dispatchCounter === 'number' && Number.isFinite(record.dispatchCounter)
      ? Math.max(0, Math.floor(record.dispatchCounter))
      : 0,
    childCounter: typeof record.childCounter === 'number' && Number.isFinite(record.childCounter)
      ? Math.max(0, Math.floor(record.childCounter))
      : 0,
    createdAt,
    updatedAt,
    inheritedSkillFiles: asStringArray(record.inheritedSkillFiles) ?? [],
    inheritedSkillIds: asStringArray(record.inheritedSkillIds) ?? [],
    localSkillFiles: asStringArray(record.localSkillFiles) ?? [],
    localSkillIds: asStringArray(record.localSkillIds) ?? [],
    resultFile: asStringOrUndefined(record.resultFile),
    error: asStringOrUndefined(record.error),
  }
}

function resolveParentPath(path: string): string | undefined {
  const dashIndex = path.lastIndexOf('-')
  if (dashIndex <= ROOT_AGENT_PATH.length) return ROOT_AGENT_PATH
  return path.slice(0, dashIndex)
}

function newNode(input: {
  conversationId: string
  runId: string
  treeId: string
  createdAt?: number
}, path: string): SubagentNodeRecord {
  const now = input.createdAt ?? Date.now()
  const safePath = path || ROOT_AGENT_PATH
  return {
    id: `${input.treeId}:${safePath}`,
    treeId: input.treeId,
    sessionId: input.conversationId,
    path: safePath,
    parentPath: safePath === ROOT_AGENT_PATH ? undefined : resolveParentPath(safePath),
    status: safePath === ROOT_AGENT_PATH ? 'running' : 'queued',
    objective: safePath === ROOT_AGENT_PATH ? 'root agent' : `agent ${safePath}`,
    dispatchCounter: 0,
    depth: parseAgentPath(safePath)?.length ?? 0,
    childCounter: 0,
    createdAt: now,
    updatedAt: now,
    inheritedSkillFiles: [],
    inheritedSkillIds: [],
    localSkillFiles: [],
    localSkillIds: [],
  }
}

function incRecord<K extends string>(record: Record<K, number>, key: K): void {
  record[key] = (record[key] ?? 0) + 1
}

function appendUnique(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value]
}

function directChildIndex(parentPath: string, childPath: string): number | undefined {
  const parentSegments = parseAgentPath(parentPath)
  const childSegments = parseAgentPath(childPath)
  if (!parentSegments || !childSegments || childSegments.length !== parentSegments.length + 1) return undefined
  if (!parentSegments.every((segment, index) => childSegments[index] === segment)) return undefined
  return childSegments[childSegments.length - 1]
}

export function parseSubagentEvents(text: string): JsonlParseResult<SubagentArchiveEvent> {
  return parseJsonl(text, {
    parse: (value) => isSubagentArchiveEvent(value) ? value : undefined,
    invalidRecordError: 'invalid subagent archive event structure',
  })
}

export function parseSubagentTreeSnapshot(text: string): JsonlParseResult<SubagentTreeSnapshot> {
  if (!text.trim()) return { records: [], parseErrors: [] }
  const parsedDocument = parseJsonDocument(text)
  if (parsedDocument.parseErrors.length > 0) {
    return { records: [], parseErrors: parsedDocument.parseErrors }
  }
  const parsed = parsedDocument.records[0]
  if (!isRecord(parsed)) {
    return {
      records: [],
      parseErrors: [{ line: 1, raw: text, error: 'tree snapshot must be a json object' }],
    }
  }

  const maybeNodes = parsed.nodes
  if (!Array.isArray(maybeNodes)) {
    return {
      records: [],
      parseErrors: [{ line: 1, raw: text, error: 'tree snapshot must be { nodes: [...] }' }],
    }
  }

  const nodes: SubagentNodeRecord[] = []
  const parseErrors: ParseError[] = []
  maybeNodes.forEach((rawNode, index) => {
    if (!isRecord(rawNode)) {
      parseErrors.push({
        line: 1,
        raw: JSON.stringify(rawNode),
        error: `invalid node record at index ${index}`,
      })
      return
    }
    const node = normalizeNodeFromSnapshot(rawNode)
    if (!node) {
      parseErrors.push({
        line: 1,
        raw: JSON.stringify(rawNode),
        error: `invalid node record at index ${index}`,
      })
      return
    }
    nodes.push(node)
  })

  return { records: [{ nodes }], parseErrors }
}

export function replaySubagentArchive(input: {
  eventsText: string
  treeText?: string
}): SubagentReplayState {
  const eventsResult = parseSubagentEvents(input.eventsText)
  const treeResult = input.treeText ? parseSubagentTreeSnapshot(input.treeText) : { records: [], parseErrors: [] }
  const events = [...eventsResult.records]
  const parseErrors = [...eventsResult.parseErrors, ...treeResult.parseErrors]

  const first = events[0]
  const conversationId = first?.conversationId ?? ''
  const runId = first?.runId ?? ''
  const treeId = first?.treeId ?? runId
  const firstTimestamp = inferTimestamp(first?.timestamp)

  const nodeMap: Record<string, SubagentNodeRecord> = {}
  const childResults: ChildAgentResult[] = []
  // 从同一份白名单派生，避免在本文件里维护第二份 15 行的类型清单。
  const eventCounts = Object.fromEntries(
    SUBAGENT_EVENT_TYPES.map((type) => [type, 0]),
  ) as Record<SubagentArchiveEventType, number>

  // The snapshot hydrates the latest known node metadata. Events are then replayed
  // in archive order to reconstruct transitions and results. Monotonic counters are
  // merged by their observed maximum so replaying pre-snapshot events is idempotent.
  for (const node of treeResult.records.flatMap((record) => record.nodes)) {
    nodeMap[node.path] = cloneNode(node)
  }

  for (const event of events) {
    incRecord(eventCounts, event.type)
    const path = event.agentPath
    if (!path) continue
    const data = event.data ?? {}
    let node = nodeMap[path]
    if (!node) {
      node = newNode({ conversationId, runId, treeId, createdAt: firstTimestamp }, path)
      nodeMap[path] = node
    }

    const eventTs = inferTimestamp(event.timestamp)
    node.updatedAt = eventTs ?? Date.now()

    if (event.type === 'archive_initialized') {
      node.status = 'running'
      continue
    }

    if (event.type === 'children_reserved') {
      const paths = asStringArray(data.paths) ?? []
      if (typeof data.dispatchCounter === 'number' && Number.isFinite(data.dispatchCounter)) {
        node.dispatchCounter = Math.max(node.dispatchCounter, Math.max(0, Math.floor(data.dispatchCounter)))
      }
      for (const childPath of paths) {
        const child = nodeMap[childPath] ?? newNode({ conversationId, runId, treeId, createdAt: firstTimestamp }, childPath)
        nodeMap[childPath] = {
          ...child,
          parentPath: node.path,
          status: 'queued',
        }
      }
      const observedChildCounter = paths.reduce((highest, childPath) => {
        const childIndex = directChildIndex(node.path, childPath)
        return childIndex === undefined ? highest : Math.max(highest, childIndex)
      }, 0)
      node.childCounter = Math.max(node.childCounter, observedChildCounter)
      continue
    }

    if (event.type === 'child_started') {
      node.status = 'running'
      const existingLocalSkillIds = asStringArray(data.skillIds)
      if (existingLocalSkillIds && existingLocalSkillIds.length > 0) {
        node.localSkillIds = [...existingLocalSkillIds]
      }
      if (typeof data.skillId === 'string') {
        node.localSkillIds = appendUnique(node.localSkillIds, data.skillId)
      }
      if (Array.isArray(data.inheritedSkillIds)) node.inheritedSkillIds = [...(data.inheritedSkillIds as string[])]
      if (typeof data.path === 'string' && data.path.endsWith('.md')) {
        node.localSkillFiles = appendUnique(node.localSkillFiles, data.path)
      }
      if (typeof data.globalPath === 'string' && data.globalPath.endsWith('.md')) {
        node.localSkillFiles = appendUnique(node.localSkillFiles, data.globalPath)
      }
      continue
    }

    if (event.type === 'child_finished') {
      node.status = data.status === 'failed'
        ? 'failed'
        : data.status === 'cancelled'
          ? 'cancelled'
          : 'done'
      if (typeof data.objective === 'string' && data.objective.trim()) node.objective = data.objective.trim()
      if (typeof data.resultFile === 'string') node.resultFile = data.resultFile
      if (typeof data.error === 'string') node.error = data.error
      if (Array.isArray(data.skillIds)) node.localSkillIds = [...(data.skillIds as string[])]
      if (Array.isArray(data.skillFiles)) node.localSkillFiles = [...(data.skillFiles as string[])]

      childResults.push({
        path: node.path,
        status: node.status === 'failed' ? 'failed' : node.status === 'cancelled' ? 'cancelled' : 'done',
        objective: asStringOrUndefined(data.objective) || node.objective,
        summary: asStringOrUndefined(data.summary) || `child ${node.path} completed`,
        resultFile: node.resultFile,
        skillFiles: [...node.localSkillFiles],
        skillIds: [...node.localSkillIds],
        modelTier: data.modelTier === 'flash' ? 'flash' : data.modelTier === 'pro' ? 'pro' : undefined,
        routeReason: asStringOrUndefined(data.route_reason),
        fallbackCount: typeof data.fallback_count === 'number' && Number.isFinite(data.fallback_count)
          ? Math.max(0, Math.floor(data.fallback_count))
          : undefined,
        error: node.error,
      })
      continue
    }

    if (event.type === 'skill_written') {
      if (typeof data.path === 'string') {
        node.localSkillFiles = appendUnique(node.localSkillFiles, data.path)
      }
      if (typeof data.globalPath === 'string') {
        node.localSkillFiles = appendUnique(node.localSkillFiles, data.globalPath)
      }
      continue
    }

    if (event.type === 'delegate_requested') {
      if (typeof data.objective === 'string' && data.objective.trim()) node.objective = data.objective.trim()
      node.status = 'running'
      continue
    }

    if (event.type === 'delegate_finished') {
      if (data.status === 'failed' || data.status === 'cancelled' || data.status === 'done') {
        node.status = data.status
      }
      continue
    }
  }

  const summary = {
    total: Object.keys(nodeMap).length,
    running: 0,
    distilling: 0,
    queued: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
  }

  for (const node of Object.values(nodeMap)) {
    if (node.status === 'running') summary.running += 1
    if (node.status === 'distilling') summary.distilling += 1
    if (node.status === 'queued') summary.queued += 1
    if (node.status === 'done') summary.done += 1
    if (node.status === 'failed') summary.failed += 1
    if (node.status === 'cancelled') summary.cancelled += 1
  }

  const orderedPaths = [...Object.keys(nodeMap)].sort(compareAgentPaths)

  return {
    conversationId,
    runId,
    treeId,
    eventCounts,
    events,
    parseErrors,
    nodes: nodeMap,
    orderedPaths,
    childResults,
    summary,
  }
}
