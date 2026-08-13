import { atom } from '@einfach/core'
import { createLatestOnlyLoader } from './createLatestOnlyLoader'
import { isMissingSubagentArchiveError } from './subagentArchiveErrors'
import {
  parseJsonl,
  parseJsonlLines,
  readSubagentRunIndexPage,
  subagentIndexPath,
  type JsonlLine,
  type RunIndexPageReader,
} from './subagentArchiveReader'
import { isRecord, stringValue } from './subagentViewRecord'
import type {
  GlobalSubagentRun,
  GlobalSubagentRunSelection,
  GlobalSubagentRunsState,
} from './subagentViewTypes'

const GLOBAL_RUNS_INDEX_PATH = subagentIndexPath('runs')
// Also reject backslashes: they are path separators on Windows even though the archive
// format itself always uses forward slashes.
const ARCHIVE_RUN_PATH_PATTERN = /^\.webAgent-archive\/conversations\/([^/\\]+)\/runs\/([^/\\]+)$/
const INVALID_GLOBAL_RUN_RECORD = 'invalid global subagent run record'

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

function globalRunIndexWarning(line: number, error: string): string {
  return error === INVALID_GLOBAL_RUN_RECORD
    ? `run 索引第 ${line} 行字段或归档路径不合法，已忽略`
    : `run 索引第 ${line} 行不是合法 JSON，已忽略`
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
  if (truncated) {
    return {
      runs: [],
      warnings: [`${GLOBAL_RUNS_INDEX_PATH} 超过 200KB，无法安全展示不完整历史；请先压缩索引`],
    }
  }
  const parsed = parseJsonl(content, {
    parse: globalRunRecord,
    invalidRecordError: INVALID_GLOBAL_RUN_RECORD,
  })
  const latest = new Map<string, GlobalSubagentRun>()
  for (const run of parsed.records) latest.set(run.key, run)
  return {
    runs: [...latest.values()].sort((a, b) =>
      timestampValue(b.updatedAt ?? b.startedAt) - timestampValue(a.updatedAt ?? a.startedAt)),
    warnings: parsed.parseErrors.map((error) => globalRunIndexWarning(error.line, error.error)),
  }
}

function parseGlobalSubagentRunsPage(
  lines: readonly JsonlLine[],
): { runs: GlobalSubagentRun[]; warnings: string[] } {
  const runs: GlobalSubagentRun[] = []
  const seen = new Set<string>()
  const parsed = parseJsonlLines(lines, {
    parse: globalRunRecord,
    invalidRecordError: INVALID_GLOBAL_RUN_RECORD,
  })
  // 后端从文件尾向前返回；同一逻辑 run 第一次出现的就是最新 append 记录。
  for (const run of parsed.records) {
    if (!seen.has(run.key)) {
      seen.add(run.key)
      runs.push(run)
    }
  }
  return {
    runs,
    warnings: parsed.parseErrors.map((error) => globalRunIndexWarning(error.line, error.error)),
  }
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
  reader?: RunIndexPageReader,
): Promise<GlobalSubagentRunsState> {
  const result = await readSubagentRunIndexPage({ cursor, maxRecords: 50, workspaceRoot }, reader)
  if (result.ok === false) {
    return isMissingSubagentArchiveError(result.error)
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
const globalSubagentRunsLoader = createLatestOnlyLoader()
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
    const token = globalSubagentRunsLoader.start(get, set)
    set(globalSubagentRunsAtom, loadMore
      ? { ...current, loadingMore: true, error: undefined }
      : { workspaceRoot: input.workspaceRoot, status: 'loading', runs: [], warnings: [], hasMore: false })
    const loaded = await readGlobalSubagentRunsPage(
      input.workspaceRoot,
      loadMore ? current.cursor : undefined,
      input.reader,
    )
    if (!globalSubagentRunsLoader.isLatest(get, token)) return
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
