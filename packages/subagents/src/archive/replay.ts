import {
  compareAgentPaths,
  decodeChildFinishedArchivePayload,
  decodeChildStartedArchivePayload,
  type ChildAgentResult,
  type SubagentArchiveEvent,
  type SubagentArchiveEventType,
  type SubagentNodeRecord,
} from '@einfach-agent/core/subagents'
import type { JsonlParseError as ParseError, JsonlParseResult } from './jsonl'

export type { JsonlParseError as ParseError, JsonlParseResult } from './jsonl'

export { SUBAGENT_EVENT_TYPES, parseSubagentEvents } from './replayEventSchema'
export {
  parseSubagentTreeSnapshot,
  type SubagentTreeSnapshot,
} from './replayNodeState'

import { SUBAGENT_EVENT_TYPES, parseSubagentEvents } from './replayEventSchema'
import {
  appendUnique,
  asStringArray,
  cloneNode,
  directChildIndex,
  incRecord,
  inferTimestamp,
  newNode,
  parseSubagentTreeSnapshot,
} from './replayNodeState'

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
  const snapshotObjectivePaths = new Set(treeResult.records.flatMap((record) => record.objectivePaths ?? []))
  const startedPayloads = new Map<string, ReturnType<typeof decodeChildStartedArchivePayload>>()
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
    const started = event.type === 'child_started' ? decodeChildStartedArchivePayload(data) : undefined
    const finished = event.type === 'child_finished' ? decodeChildFinishedArchivePayload(data) : undefined
    if ((event.type === 'child_started' || event.type === 'child_finished') && !started && !finished && hasPayloadVersion(data)) {
      parseErrors.push({
        line: 0,
        raw: JSON.stringify(event),
        error: payloadError(event.type, data.child_payload_version),
      })
      continue
    }
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
      if (started) startedPayloads.set(path, started)
      node.status = 'running'
      if (!snapshotObjectivePaths.has(path) && started?.objective?.trim()) node.objective = started.objective.trim()
      const existingLocalSkillIds = asStringArray(data.skillIds)
      if (existingLocalSkillIds && existingLocalSkillIds.length > 0) {
        node.localSkillIds = [...existingLocalSkillIds]
      }
      if (started?.skillId) {
        node.localSkillIds = appendUnique(node.localSkillIds, started.skillId)
      }
      if (started?.inheritedSkillIds) node.inheritedSkillIds = [...started.inheritedSkillIds]
      if (typeof data.path === 'string' && data.path.endsWith('.md')) {
        node.localSkillFiles = appendUnique(node.localSkillFiles, data.path)
      }
      if (typeof data.globalPath === 'string' && data.globalPath.endsWith('.md')) {
        node.localSkillFiles = appendUnique(node.localSkillFiles, data.globalPath)
      }
      continue
    }

    if (event.type === 'child_finished') {
      const started = startedPayloads.get(path)
      node.status = finished?.status ?? 'done'
      if (finished?.objective?.trim()) node.objective = finished.objective.trim()
      if (finished?.resultFile) node.resultFile = finished.resultFile
      if (finished?.error) node.error = finished.error
      if (finished?.skillIds) node.localSkillIds = [...finished.skillIds]
      if (finished?.skillFiles) node.localSkillFiles = [...finished.skillFiles]

      childResults.push({
        path: node.path,
        status: node.status === 'failed' ? 'failed' : node.status === 'cancelled' ? 'cancelled' : 'done',
        objective: finished?.objective || node.objective || started?.objective || `agent ${node.path}`,
        summary: finished?.summary || `child ${node.path} completed`,
        resultFile: node.resultFile,
        skillFiles: [...node.localSkillFiles],
        skillIds: [...node.localSkillIds],
        ...(finished?.changeSets ? { changeSets: finished.changeSets } : {}),
        modelTier: finished?.modelTier ?? started?.modelTier,
        routeReason: finished?.routeReason ?? started?.routeReason,
        fallbackCount: finished?.fallbackCount ?? started?.fallbackCount,
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

function hasPayloadVersion(data: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(data, 'child_payload_version')
}

function payloadError(type: 'child_started' | 'child_finished', version: unknown): string {
  return version === 1
    ? `invalid v1 ${type} payload`
    : `unsupported ${type} payload version ${JSON.stringify(version)}`
}
