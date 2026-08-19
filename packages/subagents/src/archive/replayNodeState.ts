import {
  parseAgentPath,
  type SubagentNodeRecord,
} from '@einfach-agent/core/subagents'
import {
  parseJsonDocument,
  type JsonlParseError as ParseError,
  type JsonlParseResult,
} from './jsonl'
import { isRecord, isString } from './replayEventSchema'

export const ROOT_AGENT_PATH = 'root'

export interface SubagentTreeSnapshot {
  nodes: SubagentNodeRecord[]
}

export function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => isString(item)) ? (value as string[]) : undefined
}

export function asStringOrUndefined(value: unknown): string | undefined {
  return isString(value) ? value : undefined
}

export function inferTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!isString(value)) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

export function cloneNode(node: SubagentNodeRecord): SubagentNodeRecord {
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

export function resolveParentPath(path: string): string | undefined {
  const dashIndex = path.lastIndexOf('-')
  if (dashIndex <= ROOT_AGENT_PATH.length) return ROOT_AGENT_PATH
  return path.slice(0, dashIndex)
}

export function newNode(input: {
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

export function incRecord<K extends string>(record: Record<K, number>, key: K): void {
  record[key] = (record[key] ?? 0) + 1
}

export function appendUnique(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value]
}

export function directChildIndex(parentPath: string, childPath: string): number | undefined {
  const parentSegments = parseAgentPath(parentPath)
  const childSegments = parseAgentPath(childPath)
  if (!parentSegments || !childSegments || childSegments.length !== parentSegments.length + 1) return undefined
  if (!parentSegments.every((segment, index) => childSegments[index] === segment)) return undefined
  return childSegments[childSegments.length - 1]
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
