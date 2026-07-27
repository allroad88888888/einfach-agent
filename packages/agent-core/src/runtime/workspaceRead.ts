import { invoke, isTauri } from '@tauri-apps/api/core'

export interface ReadWorkspaceFileInput {
  path: string
  maxBytes?: number
  /** UTF-8 byte offset. Continue with the exact nextOffset returned by the previous chunk. */
  offset?: number
  /** 可选显式 workspace root（P1）；不传则 Rust 侧走 git root 兜底。 */
  workspaceRoot?: string
  /** Runtime-only：Auto 会话允许读取 workspace 外路径；工具参数不能提供此字段。 */
  allowExternalPaths?: boolean
}

export interface ReadWorkspaceFileResult {
  path: string
  content: string
  truncated: boolean
  bytes: number
  /** Byte offset at which this chunk started. */
  offset?: number
  /** Total file size in bytes at read time. */
  totalBytes?: number
  /** Present when more bytes remain; pass it back as the next input offset. */
  nextOffset?: number
  /**
   * Hash of the whole file, returned on the opening chunk (offset 0) even when the
   * read was truncated. Guards a later overwrite. Absent past 8 MB, which is beyond
   * what write_file can replace anyway.
   */
  contentHash?: string
}

export interface ReadWorkspaceRunIndexPageInput {
  cursor?: string
  maxRecords?: number
  workspaceRoot?: string
}

export interface WorkspaceJsonlLine {
  lineNumber: number
  content: string
}

export interface ReadWorkspaceRunIndexPageResult {
  path: string
  lines: WorkspaceJsonlLine[]
  cursor?: string
  hasMore: boolean
  snapshot: string
}

export interface ListWorkspaceFilesInput {
  path?: string
  recursive?: boolean
  maxEntries?: number
  includeHidden?: boolean
  /** 可选显式 workspace root（P1）；不传则 Rust 侧走 git root 兜底。 */
  workspaceRoot?: string
  /** Runtime-only：Auto 会话允许读取 workspace 外路径；工具参数不能提供此字段。 */
  allowExternalPaths?: boolean
}

export interface WorkspaceFileEntry {
  path: string
  type: string
  size?: number
}

export interface ListWorkspaceFilesResult {
  entries: WorkspaceFileEntry[]
  truncated: boolean
}

export interface SearchWorkspaceFilesInput {
  query: string
  path?: string
  glob?: string
  maxMatches?: number
  /** 可选显式 workspace root（P1）；不传则 Rust 侧走 git root 兜底。 */
  workspaceRoot?: string
  /** Runtime-only：Auto 会话允许读取 workspace 外路径；工具参数不能提供此字段。 */
  allowExternalPaths?: boolean
}

export interface WorkspaceSearchMatch {
  path: string
  line: string
  lineNumber: number
}

export interface SearchWorkspaceFilesResult {
  matches: WorkspaceSearchMatch[]
  truncated: boolean
}

export type WorkspaceRuntimeResult<T> = { ok: true; data: T } | { ok: false; error: string }

type TauriReadWorkspaceFileInput = {
  path: string
  max_bytes?: number
  offset?: number
  workspace_root?: string
  allow_external_paths?: boolean
}

type TauriReadWorkspaceRunIndexPageInput = {
  cursor?: string
  max_records?: number
  workspace_root?: string
}

type TauriListWorkspaceFilesInput = {
  path?: string
  recursive?: boolean
  max_entries?: number
  include_hidden?: boolean
  workspace_root?: string
  allow_external_paths?: boolean
}

type TauriSearchWorkspaceFilesInput = {
  query: string
  path?: string
  glob?: string
  max_matches?: number
  workspace_root?: string
  allow_external_paths?: boolean
}

function ok<T>(data: T): WorkspaceRuntimeResult<T> {
  return { ok: true, data }
}

function fail<T>(error: string): WorkspaceRuntimeResult<T> {
  return { ok: false, error }
}

function messageFromError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function optionalNumberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function toTauriReadInput(input: ReadWorkspaceFileInput): TauriReadWorkspaceFileInput {
  return {
    path: input.path,
    max_bytes: input.maxBytes,
    offset: input.offset,
    workspace_root: input.workspaceRoot,
    allow_external_paths: input.allowExternalPaths,
  }
}

function toTauriRunIndexPageInput(
  input: ReadWorkspaceRunIndexPageInput,
): TauriReadWorkspaceRunIndexPageInput {
  return {
    cursor: input.cursor,
    max_records: input.maxRecords,
    workspace_root: input.workspaceRoot,
  }
}

function toTauriListInput(input: ListWorkspaceFilesInput): TauriListWorkspaceFilesInput {
  return {
    path: input.path,
    recursive: input.recursive,
    max_entries: input.maxEntries,
    include_hidden: input.includeHidden,
    workspace_root: input.workspaceRoot,
    allow_external_paths: input.allowExternalPaths,
  }
}

function toTauriSearchInput(input: SearchWorkspaceFilesInput): TauriSearchWorkspaceFilesInput {
  return {
    query: input.query,
    path: input.path,
    glob: input.glob,
    max_matches: input.maxMatches,
    workspace_root: input.workspaceRoot,
    allow_external_paths: input.allowExternalPaths,
  }
}

function normalizeReadResult(raw: unknown): WorkspaceRuntimeResult<ReadWorkspaceFileResult> {
  if (!isRecord(raw)) {
    return fail('read_workspace_file returned an invalid response')
  }

  const content = stringValue(raw.content, '')
  const result: ReadWorkspaceFileResult = {
    path: stringValue(raw.path, ''),
    content,
    truncated: booleanValue(raw.truncated, false),
    bytes: numberValue(raw.bytes, content.length),
    offset: numberValue(raw.offset, 0),
    totalBytes: numberValue(
      raw.totalBytes ?? raw.total_bytes,
      numberValue(raw.offset, 0) + numberValue(raw.bytes, content.length),
    ),
  }
  const nextOffset = optionalNumberValue(raw.nextOffset ?? raw.next_offset)
  if (nextOffset !== undefined) result.nextOffset = nextOffset
  const contentHash = raw.contentHash ?? raw.content_hash
  if (
    typeof contentHash === 'string' &&
    /^sha256:[0-9a-f]{64}$/.test(contentHash)
  ) {
    result.contentHash = contentHash
  }
  return ok(result)
}

function normalizeRunIndexPageResult(
  raw: unknown,
): WorkspaceRuntimeResult<ReadWorkspaceRunIndexPageResult> {
  if (!isRecord(raw) || !Array.isArray(raw.lines)) {
    return fail('read_workspace_run_index_page returned an invalid response')
  }
  const lines = raw.lines.flatMap((value): WorkspaceJsonlLine[] => {
    if (!isRecord(value)) return []
    const lineNumber = numberValue(value.lineNumber ?? value.line_number, 0)
    const content = stringValue(value.content, '')
    return lineNumber > 0 ? [{ lineNumber, content }] : []
  })
  const snapshot = stringValue(raw.snapshot, '')
  if (!snapshot) return fail('read_workspace_run_index_page returned an invalid snapshot')
  const cursor = typeof raw.cursor === 'string' && raw.cursor ? raw.cursor : undefined
  return ok({
    path: stringValue(raw.path, ''),
    lines,
    cursor,
    hasMore: booleanValue(raw.hasMore ?? raw.has_more, false),
    snapshot,
  })
}

function normalizeEntries(value: unknown): WorkspaceFileEntry[] {
  if (!Array.isArray(value)) return []

  const entries: WorkspaceFileEntry[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const path = stringValue(item.path, '')
    const type = stringValue(item.type, '')
    if (!path || !type) continue

    const size = optionalNumberValue(item.size)
    const entry: WorkspaceFileEntry = { path, type }
    if (size !== undefined) entry.size = size
    entries.push(entry)
  }
  return entries
}

function normalizeListResult(raw: unknown): WorkspaceRuntimeResult<ListWorkspaceFilesResult> {
  if (!isRecord(raw)) {
    return fail('list_workspace_files returned an invalid response')
  }

  return ok({
    entries: normalizeEntries(raw.entries),
    truncated: booleanValue(raw.truncated, false),
  })
}

function normalizeMatches(value: unknown): WorkspaceSearchMatch[] {
  if (!Array.isArray(value)) return []

  const matches: WorkspaceSearchMatch[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const path = stringValue(item.path, '')
    const line = stringValue(item.line, '')
    const lineNumber = numberValue(item.lineNumber ?? item.line_number, 0)
    if (!path || lineNumber <= 0) continue
    matches.push({ path, line, lineNumber })
  }
  return matches
}

function normalizeSearchResult(raw: unknown): WorkspaceRuntimeResult<SearchWorkspaceFilesResult> {
  if (!isRecord(raw)) {
    return fail('search_workspace_files returned an invalid response')
  }

  return ok({
    matches: normalizeMatches(raw.matches),
    truncated: booleanValue(raw.truncated, false),
  })
}

export async function readWorkspaceFile(
  input: ReadWorkspaceFileInput,
): Promise<WorkspaceRuntimeResult<ReadWorkspaceFileResult>> {
  if (!isTauri()) {
    return fail('read_workspace_file is only available in the Tauri desktop runtime')
  }

  try {
    const raw = await invoke<unknown>('read_workspace_file', toTauriReadInput(input))
    return normalizeReadResult(raw)
  } catch (error) {
    return fail(`read_workspace_file failed: ${messageFromError(error)}`)
  }
}

export async function readWorkspaceRunIndexPage(
  input: ReadWorkspaceRunIndexPageInput,
): Promise<WorkspaceRuntimeResult<ReadWorkspaceRunIndexPageResult>> {
  if (!isTauri()) {
    return fail('read_workspace_run_index_page is only available in the Tauri desktop runtime')
  }

  try {
    const raw = await invoke<unknown>('read_workspace_run_index_page', toTauriRunIndexPageInput(input))
    return normalizeRunIndexPageResult(raw)
  } catch (error) {
    return fail(`read_workspace_run_index_page failed: ${messageFromError(error)}`)
  }
}

export async function listWorkspaceFiles(
  input: ListWorkspaceFilesInput,
): Promise<WorkspaceRuntimeResult<ListWorkspaceFilesResult>> {
  if (!isTauri()) {
    return fail('list_workspace_files is only available in the Tauri desktop runtime')
  }

  try {
    const raw = await invoke<unknown>('list_workspace_files', toTauriListInput(input))
    return normalizeListResult(raw)
  } catch (error) {
    return fail(`list_workspace_files failed: ${messageFromError(error)}`)
  }
}

export async function searchWorkspaceFiles(
  input: SearchWorkspaceFilesInput,
): Promise<WorkspaceRuntimeResult<SearchWorkspaceFilesResult>> {
  if (!isTauri()) {
    return fail('search_workspace_files is only available in the Tauri desktop runtime')
  }

  try {
    const raw = await invoke<unknown>('search_workspace_files', toTauriSearchInput(input))
    return normalizeSearchResult(raw)
  } catch (error) {
    return fail(`search_workspace_files failed: ${messageFromError(error)}`)
  }
}
