import type {
  ChildAgentResult,
  SubagentArchiveEvent,
  SubagentArchiveEventType,
  SubagentNodeRecord,
} from './types'
import { compareAgentPaths, parseAgentPath } from './path'

const SUBAGENT_EVENT_TYPES: SubagentArchiveEventType[] = [
  'archive_initialized',
  'delegate_requested',
  'children_reserved',
  'skill_written',
  'child_started',
  'child_tool_schema_requested',
  'child_tool_finished',
  'nested_delegate_requested',
  'child_finished',
  'tree_snapshot_written',
  'delegate_finished',
  // 与 types.ts 的 SubagentArchiveEventType 联合一一对应 —— 漏一个，该类事件就会被
  // isSubagentArchiveEvent 判为结构非法而落进 parseErrors，eventCounts 也不再统计它。
  'child_context_compacted',
  'child_context_over_budget',
]

const ROOT_AGENT_PATH = 'root'

export interface ParseError {
  line: number
  raw: string
  error: string
}

export interface JsonlParseResult<T> {
  records: T[]
  parseErrors: ParseError[]
}

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
  const records: SubagentArchiveEvent[] = []
  const parseErrors: ParseError[] = []

  const lines = text.split('\n')
  lines.forEach((line, index) => {
    const raw = line.trim()
    if (!raw) return
    try {
      const parsed = JSON.parse(raw)
      if (!isSubagentArchiveEvent(parsed)) {
        parseErrors.push({
          line: index + 1,
          raw,
          error: 'invalid subagent archive event structure',
        })
        return
      }
      records.push(parsed)
    } catch (error) {
      parseErrors.push({
        line: index + 1,
        raw,
        error: error instanceof Error ? error.message : 'invalid json line',
      })
    }
  })

  return { records, parseErrors }
}

export function parseSubagentTreeSnapshot(text: string): JsonlParseResult<SubagentTreeSnapshot> {
  const parseErrors: ParseError[] = []
  try {
    const trimmed = text.trim()
    if (!trimmed) return { records: [], parseErrors }

    const parsed = JSON.parse(trimmed)
    if (!isRecord(parsed)) {
      parseErrors.push({ line: 1, raw: text, error: 'tree snapshot must be a json object' })
      return { records: [], parseErrors }
    }

    const maybeNodes = parsed.nodes
    if (!Array.isArray(maybeNodes)) {
      parseErrors.push({ line: 1, raw: text, error: 'tree snapshot must be { nodes: [...] }' })
      return { records: [], parseErrors }
    }

    const nodes: SubagentNodeRecord[] = []
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
  } catch (error) {
    parseErrors.push({
      line: 1,
      raw: text,
      error: error instanceof Error ? error.message : 'invalid json',
    })
    return { records: [], parseErrors }
  }
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
  const eventCounts: Record<SubagentArchiveEventType, number> = {
    archive_initialized: 0,
    delegate_requested: 0,
    children_reserved: 0,
    skill_written: 0,
    child_started: 0,
    child_tool_schema_requested: 0,
    child_tool_finished: 0,
    nested_delegate_requested: 0,
    child_finished: 0,
    tree_snapshot_written: 0,
    delegate_finished: 0,
    child_context_compacted: 0,
    child_context_over_budget: 0,
  }

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
