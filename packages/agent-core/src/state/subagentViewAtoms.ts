import { atom } from '@einfach/core'
import type { ConversationItem } from './core.type'
import { itemsAtom } from './sessionAtoms'
import type { SubagentNodeStatus } from '../subagents/types'
import { parseAgentPath } from '../subagents/path'
import { replaySubagentArchive, type SubagentReplayState } from '../subagents/replay'
import { subagentEventsPath, subagentIndexPath, subagentTreePath } from '../subagents/skillCache'
import {
  readWorkspaceRunIndexPage,
  readWorkspaceFile,
  type ReadWorkspaceFileInput,
  type ReadWorkspaceFileResult,
  type ReadWorkspaceRunIndexPageInput,
  type ReadWorkspaceRunIndexPageResult,
  type WorkspaceRuntimeResult,
} from '../runtime/workspaceRead'

export interface SubagentTreeViewNode {
  key: string
  path: string
  parentPath?: string
  depth: number
  status: SubagentNodeStatus
  objective: string
  summary?: string
  error?: string
  resultFile?: string
  skillFiles: string[]
  skillIds: string[]
}

export interface SubagentTreeView {
  // UI 批次身份必须使用 tool call id；同一 run 内多次顶层 delegate 会共享 treeId。
  id: string
  treeId: string
  callId: string
  createdAt: number
  status: SubagentNodeStatus
  strategy?: string
  archiveBasePath?: string
  nodes: SubagentTreeViewNode[]
  source?: 'live' | 'archive'
  eventLog?: string
  warnings?: string[]
}

export type SubagentArchiveLoadStatus = 'loading' | 'ready' | 'empty' | 'error'

export interface SubagentArchiveLoadState {
  archiveBasePath: string
  workspaceRoot?: string
  status: SubagentArchiveLoadStatus
  tree?: SubagentTreeView
  eventsText?: string
  error?: string
}

export interface SubagentArchivePreviewState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  kind?: 'result' | 'events'
  path?: string
  nodeKey?: string
  content?: string
  error?: string
}

export interface GlobalSubagentRun {
  key: string
  conversationId: string
  runId: string
  status: string
  archiveBasePath: string
  eventLog?: string
  model?: string
  vendor?: string
  startedAt?: string
  updatedAt?: string
}

export interface GlobalSubagentRunsState {
  workspaceRoot?: string
  status: 'idle' | 'loading' | 'ready' | 'empty' | 'error'
  runs: GlobalSubagentRun[]
  warnings: string[]
  hasMore: boolean
  loadingMore?: boolean
  cursor?: string
  snapshot?: string
  error?: string
}

export interface GlobalSubagentRunSelection {
  archiveBasePath: string
  workspaceRoot?: string
}

type ArchiveReader = (
  input: ReadWorkspaceFileInput,
) => Promise<WorkspaceRuntimeResult<ReadWorkspaceFileResult>>

export type RunIndexPageReader = (
  input: ReadWorkspaceRunIndexPageInput,
) => Promise<WorkspaceRuntimeResult<ReadWorkspaceRunIndexPageResult>>

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRecord(value: string): UnknownRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function nodeStatus(value: unknown, fallback: SubagentNodeStatus): SubagentNodeStatus {
  return value === 'queued' ||
    value === 'distilling' ||
    value === 'running' ||
    value === 'done' ||
    value === 'failed' ||
    value === 'cancelled'
    ? value
    : fallback
}

function toolResults(items: ConversationItem[]): Map<string, UnknownRecord> {
  const results = new Map<string, UnknownRecord>()
  for (const { item } of items) {
    if (item.role !== 'tool') continue
    const value = parseRecord(item.content)
    if (value) results.set(item.tool_call_id, value)
  }
  return results
}

function aggregateStatus(nodes: SubagentTreeViewNode[]): SubagentNodeStatus {
  if (nodes.some((node) => node.status === 'running' || node.status === 'distilling')) return 'running'
  if (nodes.some((node) => node.status === 'queued')) return 'queued'
  if (nodes.some((node) => node.status === 'failed')) return 'failed'
  if (nodes.some((node) => node.status === 'cancelled')) return 'cancelled'
  return 'done'
}

function resultNodes(result: UnknownRecord, treeId: string): SubagentTreeViewNode[] {
  if (!Array.isArray(result.children)) return []
  return result.children.flatMap((value) => {
    if (!isRecord(value)) return []
    const path = stringValue(value.path)
    if (!path) return []
    return [
      {
        key: `${treeId}:${path}`,
        path,
        parentPath: stringValue(result.parentPath),
        // 归档路径使用 root-01-02，而不是点号分隔；非法旧数据仍作为直属节点安全展示。
        depth: parseAgentPath(path)?.length ?? 1,
        status: nodeStatus(value.status, 'done'),
        objective: stringValue(value.objective) ?? '未命名任务',
        summary: stringValue(value.summary),
        error: stringValue(value.error),
        resultFile: stringValue(value.resultFile),
        skillFiles: stringList(value.skillFiles),
        skillIds: stringList(value.skillIds),
      },
    ]
  })
}

function pendingNodes(args: UnknownRecord | undefined, treeId: string): SubagentTreeViewNode[] {
  if (!args || !Array.isArray(args.children)) return []
  return args.children.flatMap((value, index) => {
    if (!isRecord(value)) return []
    const objective = stringValue(value.objective)
    if (!objective) return []
    const path = `pending-${index + 1}`
    return [
      {
        key: `${treeId}:${path}`,
        path,
        parentPath: 'root',
        depth: 1,
        status: 'queued' as const,
        objective,
        skillFiles: [],
        skillIds: [],
      },
    ]
  })
}

export function deriveSubagentTrees(items: ConversationItem[]): SubagentTreeView[] {
  const results = toolResults(items)
  const trees: SubagentTreeView[] = []

  for (const conversationItem of items) {
    const item = conversationItem.item
    if (item.role !== 'assistant') continue
    for (const call of item.tool_calls ?? []) {
      if (call.function.name !== 'delegate_agent') continue
      const args = parseRecord(call.function.arguments)
      const result = results.get(call.id)
      const treeId = stringValue(result?.treeId) ?? call.id
      const batchId = call.id
      const children = resultNodes(result ?? {}, batchId)
      const error = stringValue(result?.error)
      const nodes = children.length > 0 ? children : pendingNodes(args, batchId)
      const rootStatus: SubagentNodeStatus = error
        ? 'failed'
        : result
          ? aggregateStatus(nodes)
          : 'running'
      const root: SubagentTreeViewNode = {
        key: `${batchId}:root`,
        path: stringValue(result?.parentPath) ?? 'root',
        depth: 0,
        status: rootStatus,
        objective: `委派 ${nodes.length} 个子 agent`,
        error,
        skillFiles: stringList(result?.skillFiles),
        skillIds: stringList(result?.skillIds),
      }
      trees.push({
        id: batchId,
        treeId,
        callId: call.id,
        createdAt: conversationItem.createdAt,
        status: rootStatus,
        strategy: stringValue(result?.strategy) ?? stringValue(args?.strategy),
        archiveBasePath: stringValue(result?.archiveBasePath),
        nodes: [root, ...nodes],
        source: 'live',
        eventLog: stringValue(result?.eventLog),
      })
    }
  }

  return trees.sort((a, b) => b.createdAt - a.createdAt)
}

export const subagentTreesAtom = atom((get) => deriveSubagentTrees(get(itemsAtom)))

const GLOBAL_RUNS_INDEX_PATH = subagentIndexPath('runs')
// Also reject backslashes: they are path separators on Windows even though the archive
// format itself always uses forward slashes.
const ARCHIVE_RUN_PATH_PATTERN = /^\.agent-archive\/conversations\/([^/\\]+)\/runs\/([^/\\]+)$/

function archiveRunPathIsSafe(path: string): boolean {
  const match = ARCHIVE_RUN_PATH_PATTERN.exec(path)
  return Boolean(match && match[1] !== '.' && match[1] !== '..' && match[2] !== '.' && match[2] !== '..')
}

function globalRunRecord(value: unknown): GlobalSubagentRun | undefined {
  if (!isRecord(value)) return undefined
  const conversationId = stringValue(value.conversationId)
  const runId = stringValue(value.runId)
  const archiveBasePath = stringValue(value.archiveBasePath)
  if (!conversationId || !runId || !archiveBasePath || !archiveRunPathIsSafe(archiveBasePath)) return undefined
  return {
    key: `${conversationId}\0${runId}`,
    conversationId,
    runId,
    status: stringValue(value.status) ?? 'unknown',
    archiveBasePath,
    eventLog: stringValue(value.eventLog),
    model: stringValue(value.model),
    vendor: stringValue(value.vendor),
    startedAt: stringValue(value.startedAt),
    updatedAt: stringValue(value.updatedAt),
  }
}

function timestampValue(value?: string): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function parseGlobalSubagentRunsIndex(
  content: string,
  truncated = false,
): { runs: GlobalSubagentRun[]; warnings: string[] } {
  const warnings: string[] = []
  const latest = new Map<string, GlobalSubagentRun>()
  if (truncated) {
    return {
      runs: [],
      warnings: [`${GLOBAL_RUNS_INDEX_PATH} 超过 200KB，无法安全展示不完整历史；请先压缩索引`],
    }
  }
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      warnings.push(`run 索引第 ${index + 1} 行不是合法 JSON，已忽略`)
      continue
    }
    const run = globalRunRecord(parsed)
    if (!run) {
      warnings.push(`run 索引第 ${index + 1} 行字段或归档路径不合法，已忽略`)
      continue
    }
    latest.set(run.key, run)
  }
  return {
    runs: [...latest.values()].sort((a, b) =>
      timestampValue(b.updatedAt ?? b.startedAt) - timestampValue(a.updatedAt ?? a.startedAt)),
    warnings,
  }
}

function parseGlobalSubagentRunsPage(
  lines: ReadWorkspaceRunIndexPageResult['lines'],
): { runs: GlobalSubagentRun[]; warnings: string[] } {
  const runs: GlobalSubagentRun[] = []
  const seen = new Set<string>()
  const warnings: string[] = []
  // 后端从文件尾向前返回；同一逻辑 run 第一次出现的就是最新 append 记录。
  for (const line of lines) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line.content)
    } catch {
      warnings.push(`run 索引第 ${line.lineNumber} 行不是合法 JSON，已忽略`)
      continue
    }
    const run = globalRunRecord(parsed)
    if (!run) {
      warnings.push(`run 索引第 ${line.lineNumber} 行字段或归档路径不合法，已忽略`)
      continue
    }
    if (!seen.has(run.key)) {
      seen.add(run.key)
      runs.push(run)
    }
  }
  return { runs, warnings }
}

function mergeGlobalSubagentRuns(
  existing: GlobalSubagentRun[],
  olderPage: GlobalSubagentRun[],
): GlobalSubagentRun[] {
  const latest = new Map(existing.map((run) => [run.key, run]))
  for (const run of olderPage) {
    if (!latest.has(run.key)) latest.set(run.key, run)
  }
  return [...latest.values()].sort((a, b) =>
    timestampValue(b.updatedAt ?? b.startedAt) - timestampValue(a.updatedAt ?? a.startedAt))
}

export async function readGlobalSubagentRunsPage(
  workspaceRoot?: string,
  cursor?: string,
  reader: RunIndexPageReader = readWorkspaceRunIndexPage,
): Promise<GlobalSubagentRunsState> {
  const result = await reader({ cursor, maxRecords: 50, workspaceRoot })
  if (result.ok === false) {
    return isMissingArchiveError(result.error)
      ? { workspaceRoot, status: 'empty', runs: [], warnings: [], hasMore: false, error: '尚无历史 run' }
      : { workspaceRoot, status: 'error', runs: [], warnings: [], hasMore: false, error: result.error }
  }
  const parsed = parseGlobalSubagentRunsPage(result.data.lines)
  const hasDisplayablePage = parsed.runs.length > 0 || result.data.hasMore
  return {
    workspaceRoot,
    status: hasDisplayablePage ? 'ready' : 'empty',
    runs: parsed.runs,
    warnings: parsed.warnings,
    hasMore: result.data.hasMore,
    cursor: result.data.cursor,
    snapshot: result.data.snapshot,
    error: hasDisplayablePage ? undefined : 'run 索引中没有有效记录',
  }
}

export const globalSubagentRunsAtom = atom<GlobalSubagentRunsState>({
  status: 'idle',
  runs: [],
  warnings: [],
  hasMore: false,
})
const globalSubagentRunsRequestTokenAtom = atom(0)
export const selectedGlobalSubagentRunAtom = atom<GlobalSubagentRunSelection | undefined>(undefined)

export const loadGlobalSubagentRunsAtom = atom(
  null,
  async (get, set, input: {
    workspaceRoot?: string
    force?: boolean
    loadMore?: boolean
    reader?: RunIndexPageReader
  }) => {
    const current = get(globalSubagentRunsAtom)
    const loadMore = input.loadMore === true
    if (loadMore && (current.workspaceRoot !== input.workspaceRoot || !current.hasMore || !current.cursor || current.loadingMore)) return
    if (!loadMore && !input.force && current.status !== 'idle' && current.workspaceRoot === input.workspaceRoot) return
    const token = get(globalSubagentRunsRequestTokenAtom) + 1
    set(globalSubagentRunsRequestTokenAtom, token)
    set(globalSubagentRunsAtom, loadMore
      ? { ...current, loadingMore: true, error: undefined }
      : { workspaceRoot: input.workspaceRoot, status: 'loading', runs: [], warnings: [], hasMore: false })
    const loaded = await readGlobalSubagentRunsPage(
      input.workspaceRoot,
      loadMore ? current.cursor : undefined,
      input.reader,
    )
    if (get(globalSubagentRunsRequestTokenAtom) !== token) return
    if (loadMore && loaded.status !== 'error' && loaded.snapshot === current.snapshot) {
      const runs = mergeGlobalSubagentRuns(current.runs, loaded.runs)
      set(globalSubagentRunsAtom, {
        ...loaded,
        status: runs.length > 0 ? 'ready' : 'empty',
        runs,
        warnings: [...current.warnings, ...loaded.warnings],
        loadingMore: false,
      })
      return
    }
    if (loadMore && loaded.status !== 'error') {
      set(globalSubagentRunsAtom, {
        workspaceRoot: input.workspaceRoot,
        status: 'error',
        runs: [],
        warnings: [],
        hasMore: false,
        loadingMore: false,
        error: 'run 索引快照已变化，请刷新历史',
      })
      return
    }
    // cursor 失效或快照漂移时清空旧页，禁止把两个文件版本拼成貌似完整的历史。
    set(globalSubagentRunsAtom, { ...loaded, loadingMore: false })
  },
)

export const subagentArchiveLoadsAtom = atom<Record<string, SubagentArchiveLoadState>>({})
const subagentArchiveRequestTokensAtom = atom<Record<string, number>>({})

function isMissingArchiveError(error: string): boolean {
  return /does not exist|not found|no such file/i.test(error)
}

function replayTreeView(archiveBasePath: string, replay: SubagentReplayState, warnings: string[]): SubagentTreeView | undefined {
  const nodes = replay.orderedPaths.map((path): SubagentTreeViewNode => {
    const node = replay.nodes[path]
    const result = replay.childResults.find((candidate) => candidate.path === path)
    return {
      key: `archive:${archiveBasePath}:${path}`,
      path,
      parentPath: node.parentPath,
      depth: node.depth,
      status: node.status,
      objective: node.objective,
      summary: result?.summary,
      error: node.error,
      resultFile: node.resultFile,
      skillFiles: [...node.localSkillFiles],
      skillIds: [...node.localSkillIds],
    }
  })
  if (nodes.length === 0) return undefined
  const firstNode = replay.nodes[replay.orderedPaths[0]]
  const treeId = replay.treeId || firstNode?.treeId || archiveBasePath
  return {
    id: `archive:${archiveBasePath}`,
    treeId,
    callId: 'archive',
    createdAt: Math.max(...Object.values(replay.nodes).map((node) => node.updatedAt), 0),
    status: aggregateStatus(nodes),
    archiveBasePath,
    nodes,
    source: 'archive',
    eventLog: subagentEventsPath(archiveBasePath),
    warnings,
  }
}

async function readArchiveText(
  reader: ArchiveReader,
  path: string,
  workspaceRoot?: string,
): Promise<{ content?: string; warning?: string; error?: string }> {
  const result = await reader({ path, maxBytes: 200_000, workspaceRoot })
  if (!result.ok) return { error: result.error }
  return {
    content: result.data.content,
    warning: result.data.truncated ? `${path} 超过 200KB，回放内容已截断` : undefined,
  }
}

export async function readSubagentArchive(
  input: { archiveBasePath: string; workspaceRoot?: string },
  reader: ArchiveReader = readWorkspaceFile,
): Promise<SubagentArchiveLoadState> {
  const [treeResult, eventsResult] = await Promise.all([
    readArchiveText(reader, subagentTreePath(input.archiveBasePath), input.workspaceRoot),
    readArchiveText(reader, subagentEventsPath(input.archiveBasePath), input.workspaceRoot),
  ])
  if (!treeResult.content && !eventsResult.content) {
    const errors = [treeResult.error, eventsResult.error].filter((value): value is string => Boolean(value))
    return {
      ...input,
      status: errors.length > 0 && errors.every(isMissingArchiveError) ? 'empty' : 'error',
      error: errors.join('；') || '未找到可回放的归档文件',
    }
  }

  const replay = replaySubagentArchive({
    treeText: treeResult.content,
    eventsText: eventsResult.content ?? '',
  })
  const warnings = [
    treeResult.warning,
    eventsResult.warning,
    treeResult.error ? `tree.json 读取失败：${treeResult.error}` : undefined,
    eventsResult.error ? `events.jsonl 读取失败：${eventsResult.error}` : undefined,
    ...replay.parseErrors.map((error) => `归档第 ${error.line} 行：${error.error}`),
  ].filter((value): value is string => Boolean(value))
  const tree = replayTreeView(input.archiveBasePath, replay, warnings)
  if (!tree) {
    return { ...input, status: 'empty', eventsText: eventsResult.content, error: '归档中没有子 agent 节点' }
  }
  return { ...input, status: 'ready', tree, eventsText: eventsResult.content }
}

export const loadSubagentArchiveAtom = atom(
  null,
  async (get, set, input: { archiveBasePath: string; workspaceRoot?: string; force?: boolean; reader?: ArchiveReader }) => {
    const current = get(subagentArchiveLoadsAtom)[input.archiveBasePath]
    if (!input.force && current && current.workspaceRoot === input.workspaceRoot) return
    const token = (get(subagentArchiveRequestTokensAtom)[input.archiveBasePath] ?? 0) + 1
    set(subagentArchiveRequestTokensAtom, {
      ...get(subagentArchiveRequestTokensAtom),
      [input.archiveBasePath]: token,
    })
    set(subagentArchiveLoadsAtom, {
      ...get(subagentArchiveLoadsAtom),
      [input.archiveBasePath]: {
        archiveBasePath: input.archiveBasePath,
        workspaceRoot: input.workspaceRoot,
        status: 'loading',
      },
    })
    const loaded = await readSubagentArchive(input, input.reader)
    if (get(subagentArchiveRequestTokensAtom)[input.archiveBasePath] !== token) return
    set(subagentArchiveLoadsAtom, {
      ...get(subagentArchiveLoadsAtom),
      [input.archiveBasePath]: loaded,
    })
  },
)

export const archiveSubagentTreesAtom = atom((get) =>
  Object.values(get(subagentArchiveLoadsAtom))
    .flatMap((load) => load.status === 'ready' && load.tree ? [load.tree] : [])
    .sort((a, b) => b.createdAt - a.createdAt),
)

export const subagentArchivePreviewAtom = atom<SubagentArchivePreviewState>({ status: 'idle' })
const subagentArchivePreviewRequestTokenAtom = atom(0)

export function resolveSubagentArchivePath(archiveBasePath: string, path: string): string {
  const normalized = path.replace(/^\.\//, '')
  if (normalized === archiveBasePath || normalized.startsWith(`${archiveBasePath}/`) || normalized.startsWith('.agent-archive/')) {
    return normalized
  }
  return `${archiveBasePath}/${normalized}`
}

export const loadSubagentArchivePreviewAtom = atom(
  null,
  async (_get, set, input: {
    archiveBasePath: string
    path: string
    kind: 'result' | 'events'
    workspaceRoot?: string
    content?: string
    nodeKey?: string
    reader?: ArchiveReader
  }) => {
    const path = resolveSubagentArchivePath(input.archiveBasePath, input.path)
    const token = _get(subagentArchivePreviewRequestTokenAtom) + 1
    set(subagentArchivePreviewRequestTokenAtom, token)
    set(subagentArchivePreviewAtom, { status: 'loading', kind: input.kind, path, nodeKey: input.nodeKey })
    if (input.content !== undefined) {
      set(subagentArchivePreviewAtom, { status: 'ready', kind: input.kind, path, nodeKey: input.nodeKey, content: input.content })
      return
    }
    const result = await (input.reader ?? readWorkspaceFile)({ path, maxBytes: 200_000, workspaceRoot: input.workspaceRoot })
    if (_get(subagentArchivePreviewRequestTokenAtom) !== token) return
    set(subagentArchivePreviewAtom, result.ok
      ? { status: 'ready', kind: input.kind, path, nodeKey: input.nodeKey, content: result.data.content }
      : { status: 'error', kind: input.kind, path, nodeKey: input.nodeKey, error: result.error })
  },
)

// 会话 store 内的节点选择状态；切换会话 Provider 后天然隔离。
export const selectedSubagentNodeKeyAtom = atom<string | undefined>(undefined)

export const selectedSubagentNodeAtom = atom((get) => {
  const liveTrees = get(subagentTreesAtom)
  const liveArchivePaths = new Set(liveTrees.flatMap((tree) => tree.archiveBasePath ? [tree.archiveBasePath] : []))
  const globalRuns = get(globalSubagentRunsAtom)
  const globalSelection = get(selectedGlobalSubagentRunAtom)
  const selectedGlobalPath = globalRuns.status === 'ready' && globalSelection &&
    globalSelection.workspaceRoot === globalRuns.workspaceRoot &&
    globalRuns.runs.some((run) => run.archiveBasePath === globalSelection.archiveBasePath)
    ? globalSelection.archiveBasePath
    : undefined
  const archiveTrees = get(archiveSubagentTreesAtom).filter((tree) =>
    Boolean(tree.archiveBasePath && (liveArchivePaths.has(tree.archiveBasePath) || tree.archiveBasePath === selectedGlobalPath)))
  const trees = [...archiveTrees, ...liveTrees]
  const selectedKey = get(selectedSubagentNodeKeyAtom)
  if (!selectedKey) return undefined
  for (const tree of trees) {
    const node = tree.nodes.find((candidate) => candidate.key === selectedKey)
    if (node) return { tree, node }
  }
  return undefined
})
