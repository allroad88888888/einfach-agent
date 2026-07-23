const SUBAGENT_EVENT_TYPES = [
  'archive_initialized',
  'delegate_requested',
  'children_reserved',
  'skill_written',
  'child_started',
  'child_tool_schema_requested',
  'nested_delegate_requested',
  'child_finished',
  'tree_snapshot_written',
  'delegate_finished',
]

const ROOT_AGENT_PATH = 'root'

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asString(value) {
  return typeof value === 'string' ? value : undefined
}

function asStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : undefined
}

function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function isValidEvent(value) {
  return (
    isRecord(value) &&
    typeof value.eventId === 'string' &&
    typeof value.timestamp === 'string' &&
    typeof value.conversationId === 'string' &&
    typeof value.runId === 'string' &&
    typeof value.treeId === 'string' &&
    typeof value.agentPath === 'string' &&
    SUBAGENT_EVENT_TYPES.includes(value.type)
  )
}

function cloneNode(node) {
  return {
    ...node,
    inheritedSkillFiles: [...node.inheritedSkillFiles],
    inheritedSkillIds: [...node.inheritedSkillIds],
    localSkillFiles: [...node.localSkillFiles],
    localSkillIds: [...node.localSkillIds],
  }
}

function resolveParentPath(path) {
  const dashIndex = path.lastIndexOf('-')
  if (dashIndex <= ROOT_AGENT_PATH.length) return ROOT_AGENT_PATH
  return path.slice(0, dashIndex)
}

function normalizeNodeFromSnapshot(record) {
  if (!record || typeof record.path !== 'string') return null

  const status = record.status === 'running' || record.status === 'distilling' || record.status === 'done' ||
    record.status === 'failed' || record.status === 'cancelled'
    ? record.status
    : 'queued'

  const createdAt = asNumber(record.createdAt) ?? Date.now()
  const updatedAt = asNumber(record.updatedAt) ?? createdAt

  return {
    id: asString(record.id) ?? `${asString(record.treeId) ?? ''}:${record.path}`,
    treeId: asString(record.treeId) ?? '',
    sessionId: asString(record.sessionId) ?? '',
    path: record.path,
    parentPath: asString(record.parentPath) ?? (record.path === ROOT_AGENT_PATH ? undefined : resolveParentPath(record.path)),
    status,
    objective: asString(record.objective) ?? (record.path === ROOT_AGENT_PATH ? 'root agent' : `agent ${record.path}`),
    mode: asString(record.mode),
    expectedOutput: asString(record.expectedOutput),
    depth: typeof record.depth === 'number' && Number.isFinite(record.depth) ? Math.max(0, Math.floor(record.depth)) : 0,
    dispatchCounter: Number.isFinite(record.dispatchCounter) ? Math.max(0, Math.floor(record.dispatchCounter)) : 0,
    childCounter: Number.isFinite(record.childCounter) ? Math.max(0, Math.floor(record.childCounter)) : 0,
    createdAt,
    updatedAt,
    inheritedSkillFiles: asStringArray(record.inheritedSkillFiles) ?? [],
    inheritedSkillIds: asStringArray(record.inheritedSkillIds) ?? [],
    localSkillFiles: asStringArray(record.localSkillFiles) ?? [],
    localSkillIds: asStringArray(record.localSkillIds) ?? [],
    resultFile: asString(record.resultFile),
    error: asString(record.error),
  }
}

function newNode(input, safePath) {
  const now = input.createdAt ?? Date.now()
  return {
    id: `${input.treeId}:${safePath}`,
    treeId: input.treeId,
    sessionId: input.conversationId,
    path: safePath,
    parentPath: safePath === ROOT_AGENT_PATH ? undefined : resolveParentPath(safePath),
    status: safePath === ROOT_AGENT_PATH ? 'running' : 'queued',
    objective: safePath === ROOT_AGENT_PATH ? 'root agent' : `agent ${safePath}`,
    dispatchCounter: 0,
    depth: safePath === ROOT_AGENT_PATH ? 0 : safePath.split('-').length - 1,
    childCounter: 0,
    createdAt: now,
    updatedAt: now,
    inheritedSkillFiles: [],
    inheritedSkillIds: [],
    localSkillFiles: [],
    localSkillIds: [],
  }
}

function asEventData(event) {
  return isRecord(event.data) ? event.data : {}
}

function appendUnique(values, value) {
  return values.includes(value) ? values : [...values, value]
}

function directChildIndex(parentPath, childPath) {
  const prefix = `${parentPath}-`
  if (!childPath.startsWith(prefix)) return undefined
  const suffix = childPath.slice(prefix.length)
  if (!/^(0*[1-9]\d*)$/.test(suffix)) return undefined
  const value = Number(suffix)
  return Number.isSafeInteger(value) ? value : undefined
}

function parseAgentPathForSort(path) {
  if (path === ROOT_AGENT_PATH) return [0]
  const [, ...parts] = path.split('-')
  return [0, ...parts.map((part) => Number.parseInt(part, 10))]
}

export function parseSubagentEvents(text) {
  const records = []
  const parseErrors = []

  const lines = text.split('\n')
  lines.forEach((line, index) => {
    const raw = line.trim()
    if (!raw) return
    try {
      const parsed = JSON.parse(raw)
      if (!isValidEvent(parsed)) {
        parseErrors.push({ line: index + 1, raw, error: 'invalid subagent archive event structure' })
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

export function parseSubagentTreeSnapshot(text) {
  const parseErrors = []
  try {
    const trimmed = text.trim()
    if (!trimmed) return { records: [], parseErrors }

    const parsed = JSON.parse(trimmed)
    if (!isRecord(parsed)) {
      parseErrors.push({ line: 1, raw: text, error: 'tree snapshot must be a json object' })
      return { records: [], parseErrors }
    }
    if (!Array.isArray(parsed.nodes)) {
      parseErrors.push({ line: 1, raw: text, error: 'tree snapshot must be { nodes: [...] }' })
      return { records: [], parseErrors }
    }

    const nodes = []
    parsed.nodes.forEach((rawNode, index) => {
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
    parseErrors.push({ line: 1, raw: text, error: error instanceof Error ? error.message : 'invalid json' })
    return { records: [], parseErrors }
  }
}

export function replaySubagentArchive(input) {
  const eventsResult = parseSubagentEvents(input.eventsText)
  const treeResult = input.treeText ? parseSubagentTreeSnapshot(input.treeText) : { records: [], parseErrors: [] }
  const events = [...eventsResult.records]
  const parseErrors = [...eventsResult.parseErrors, ...treeResult.parseErrors]

  const first = events[0]
  const conversationId = first?.conversationId ?? ''
  const runId = first?.runId ?? ''
  const treeId = first?.treeId ?? runId
  const firstTimestamp = parseTimestamp(first?.timestamp)

  const nodeMap = Object.create(null)
  const childResults = []
  const eventCounts = {
    archive_initialized: 0,
    delegate_requested: 0,
    children_reserved: 0,
    skill_written: 0,
    child_started: 0,
    child_tool_schema_requested: 0,
    nested_delegate_requested: 0,
    child_finished: 0,
    tree_snapshot_written: 0,
    delegate_finished: 0,
  }

  // The snapshot hydrates the latest known node metadata. Events are then replayed
  // in archive order to reconstruct transitions and results. Monotonic counters are
  // merged by their observed maximum so replaying pre-snapshot events is idempotent.
  for (const node of treeResult.records.flatMap((record) => record.nodes)) {
    nodeMap[node.path] = cloneNode(node)
  }

  for (const event of events) {
    eventCounts[event.type] += 1
    const path = event.agentPath
    const data = asEventData(event)
    let node = nodeMap[path]
    if (!node) {
      node = newNode({ conversationId, runId, treeId, createdAt: firstTimestamp }, path)
      nodeMap[path] = node
    }

    const eventTs = parseTimestamp(event.timestamp)
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
      const localSkillIds = asStringArray(data.skillIds)
      if (localSkillIds && localSkillIds.length > 0) {
        node.localSkillIds = [...localSkillIds]
      }
      if (typeof data.skillId === 'string') {
        node.localSkillIds = appendUnique(node.localSkillIds, data.skillId)
      }
      if (Array.isArray(data.inheritedSkillIds)) {
        node.inheritedSkillIds = [...data.inheritedSkillIds]
      }
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
      if (typeof data.objective === 'string' && data.objective.trim()) {
        node.objective = data.objective.trim()
      }
      if (typeof data.resultFile === 'string') node.resultFile = data.resultFile
      if (typeof data.error === 'string') node.error = data.error
      if (Array.isArray(data.skillIds)) node.localSkillIds = [...data.skillIds]
      if (Array.isArray(data.skillFiles)) node.localSkillFiles = [...data.skillFiles]

      childResults.push({
        path: node.path,
        status: node.status === 'failed' ? 'failed' : node.status === 'cancelled' ? 'cancelled' : 'done',
        objective: asString(data.objective) || node.objective,
        summary: asString(data.summary) || `child ${node.path} completed`,
        resultFile: node.resultFile,
        skillFiles: [...node.localSkillFiles],
        skillIds: [...node.localSkillIds],
        error: node.error,
      })
      continue
    }

    if (event.type === 'skill_written') {
      if (typeof data.path === 'string') node.localSkillFiles = appendUnique(node.localSkillFiles, data.path)
      if (typeof data.globalPath === 'string') node.localSkillFiles = appendUnique(node.localSkillFiles, data.globalPath)
      continue
    }

    if (event.type === 'delegate_requested') {
      if (typeof data.objective === 'string' && data.objective.trim()) {
        node.objective = data.objective.trim()
      }
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

  const orderedPaths = [...Object.keys(nodeMap)].sort((a, b) => {
    if (a === ROOT_AGENT_PATH) return -1
    if (b === ROOT_AGENT_PATH) return 1
    const aParts = parseAgentPathForSort(a)
    const bParts = parseAgentPathForSort(b)
    const max = Math.max(aParts.length, bParts.length)
    for (let i = 0; i < max; i += 1) {
      const av = Number.isFinite(aParts[i]) ? aParts[i] : 0
      const bv = Number.isFinite(bParts[i]) ? bParts[i] : 0
      if (av !== bv) return av - bv
    }
    return a.localeCompare(b)
  })

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

function statusBadge(status) {
  const label = typeof status === 'string' ? status : 'unknown'
  return {
    queued: 'queued',
    distilling: 'distilling',
    running: 'running',
    done: 'done',
    failed: 'failed',
    cancelled: 'cancelled',
  }[label] ?? 'unknown'
}

function formatNodeRow(node) {
  const dispatch = node.dispatchCounter ? `${node.dispatchCounter}` : '-'
  const skillCount = node.localSkillFiles.length
  const inherited = node.inheritedSkillFiles.length
  const result = node.resultFile ? node.resultFile : '-'
  return `| \`${node.path}\` | ${statusBadge(node.status)} | ${dispatch} | ${skillCount} | ${inherited} | ${result} |`
}

function formatList(title, values, mapper) {
  if (!values || values.length === 0) {
    return `### ${title}\n\n暂无数据。\n`
  }
  return `### ${title}\n\n` + values.map((item, index) => mapper(item, index)).join('\n') + '\n'
}

function formatParseErrors(errors) {
  if (!errors.length) return ''
  return [
    '### 解析异常',
    '',
    ...errors.map((error) => `- 行 ${error.line}: ${error.error}`),
    '',
  ].join('\n')
}

export function formatReplayReport(state) {
  const totalEvents = Object.values(state.eventCounts).reduce((sum, value) => sum + value, 0)
  const sections = [
    '# 子 Agent 复盘报告',
    '',
    `- 会话: ${state.conversationId || '-'}`,
    `- Run: ${state.runId || '-'}`,
    `- Tree: ${state.treeId || '-'}`,
    `- 事件总数: ${totalEvents}`,
    '',
    '## 事件统计',
    ...Object.entries(state.eventCounts).map(([key, value]) => `- ${key}: ${value}`),
    '',
    '## 节点汇总',
    `- total: ${state.summary.total}`,
    `- running: ${state.summary.running}`,
    `- distilling: ${state.summary.distilling}`,
    `- queued: ${state.summary.queued}`,
    `- done: ${state.summary.done}`,
    `- failed: ${state.summary.failed}`,
    `- cancelled: ${state.summary.cancelled}`,
    '',
    '## 节点树状态',
    '',
    '| path | status | dispatch | local skill 文件 | inherited skill 文件 | result |',
    '| --- | --- | --- | --- | --- | --- |',
  ]

  for (const nodePath of state.orderedPaths) {
    const node = state.nodes[nodePath]
    if (!node) continue
    sections.push(formatNodeRow(node))
  }

  sections.push(
    '',
    formatList(
      '子任务结果',
      state.childResults,
      (result) =>
        `- \`${result.path}\` ${result.status} · ${result.summary}` + (result.error ? ` · ${result.error}` : ''),
    ),
  )
  sections.push(formatParseErrors(state.parseErrors))
  if (!state.parseErrors.length) {
    sections.push('### 解析异常\n\n无')
  }

  return `${sections.filter(Boolean).join('\n').trim()}\n`
}
