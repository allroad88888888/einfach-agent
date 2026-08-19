import { hasHostBridge, loadHostInvoke } from './hostBridge'
import {
  normalizeChangeSummary,
  type WorkspaceChangeContext,
  type WorkspaceChangeSummary,
} from './workspaceChange'
import { getDefaultObservabilityPort, type ObservabilityPort } from '../observability/port'

export type WorkspaceWriteMode = 'create' | 'overwrite' | 'append' | 'upsert'

/** What actually changed on disk, so callers do not have to re-read to confirm. */
export interface WorkspaceWriteChangeSummary {
  linesAdded: number
  linesRemoved: number
  beforeLines: number
  afterLines: number
  /** Unified diff of the changed region, truncated by the host. */
  diff?: string
  diffTruncated: boolean
  /** The changed region was too large for a minimal diff; counts are an upper bound. */
  approximate: boolean
}

export type WorkspaceWriteEncoding = 'utf8' | 'base64'

export interface WorkspaceWriteInput {
  path: string
  content: string
  mode?: WorkspaceWriteMode
  /** How `content` is carried. base64 is the only way to produce binary files. */
  encoding?: WorkspaceWriteEncoding
  /** Explicitly set or clear the executable bit after writing. Unix only. */
  executable?: boolean
  /** Validate and report the change without touching disk. */
  dryRun?: boolean
  expectedOldContent?: string
  /** A contentHash returned by a complete readWorkspaceFile call. */
  expectedContentHash?: string
  createDirs?: boolean
  maxBytes?: number
  /** Serialize this target across app processes. Used by the subagent archive. */
  exclusivePathLock?: boolean
  /** 可选显式 workspace root（P1）；不传则 Rust 侧走 git root 兜底。 */
  workspaceRoot?: string
  /** Runtime-only audit metadata; tool arguments cannot provide this. */
  changeContext?: WorkspaceChangeContext
}

export interface WorkspaceWriteResult {
  ok: boolean
  path: string
  bytesWritten: number
  created: boolean
  overwritten: boolean
  appended: boolean
  error?: string
  changeSet?: WorkspaceChangeSummary
  changeSummary?: WorkspaceWriteChangeSummary
  /** False when the write succeeded but produced no rollback entry. */
  reversible?: boolean
  /** Why the write is not reversible. Only present when `reversible` is false. */
  reversibleReason?: string
  /** True when nothing was written because `dryRun` was requested. */
  dryRun?: boolean
  wouldChange?: boolean
}

type TauriWorkspaceWriteInput = {
  path: string
  content: string
  mode?: WorkspaceWriteMode
  encoding?: WorkspaceWriteEncoding
  executable?: boolean
  dry_run?: boolean
  expected_old_content?: string
  expected_content_hash?: string
  create_dirs?: boolean
  max_bytes?: number
  exclusive_path_lock?: boolean
  workspace_root?: string
  change_context?: WorkspaceChangeContext
  diagnostic_operation_id?: string
}

function toTauriInput(
  input: WorkspaceWriteInput,
  diagnosticOperationId: string,
): TauriWorkspaceWriteInput {
  return {
    path: input.path,
    content: input.content,
    mode: input.mode,
    encoding: input.encoding,
    executable: input.executable,
    dry_run: input.dryRun,
    expected_old_content: input.expectedOldContent,
    expected_content_hash: input.expectedContentHash,
    create_dirs: input.createDirs,
    max_bytes: input.maxBytes,
    exclusive_path_lock: input.exclusivePathLock,
    workspace_root: input.workspaceRoot,
    change_context: input.changeContext,
    diagnostic_operation_id: diagnosticOperationId,
  }
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

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

function diagnosticPath(path: string): string {
  const absolute = path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path)
  if (absolute) return `<absolute-path:${path.length}-chars>`
  return path.length > 240 ? `${path.slice(0, 237)}...` : path
}

function failedResult(input: WorkspaceWriteInput, error: string): WorkspaceWriteResult {
  return {
    ok: false,
    path: input.path,
    bytesWritten: 0,
    created: false,
    overwritten: false,
    appended: false,
    error,
  }
}

/** Exported so apply_patch can report per-file changes in the identical shape. */
export function normalizeWriteChangeSummary(
  raw: unknown,
): WorkspaceWriteChangeSummary | undefined {
  if (!isRecord(raw)) return undefined
  const linesAdded = raw.linesAdded ?? raw.lines_added
  const linesRemoved = raw.linesRemoved ?? raw.lines_removed
  if (typeof linesAdded !== 'number' || typeof linesRemoved !== 'number') return undefined
  const summary: WorkspaceWriteChangeSummary = {
    linesAdded,
    linesRemoved,
    beforeLines: numberValue(raw.beforeLines ?? raw.before_lines, 0),
    afterLines: numberValue(raw.afterLines ?? raw.after_lines, 0),
    diffTruncated: booleanValue(raw.diffTruncated ?? raw.diff_truncated, false),
    approximate: booleanValue(raw.approximate, false),
  }
  const diff = raw.diff
  if (typeof diff === 'string' && diff.length > 0) summary.diff = diff
  return summary
}

function normalizeResult(raw: unknown, input: WorkspaceWriteInput): WorkspaceWriteResult {
  if (!isRecord(raw)) {
    return failedResult(input, 'write_workspace_file returned an invalid response')
  }

  const ok = booleanValue(raw.ok, false)
  const error = stringValue(raw.error, '')
  const result: WorkspaceWriteResult = {
    ok,
    path: stringValue(raw.path, input.path),
    bytesWritten: numberValue(raw.bytesWritten ?? raw.bytes_written, ok ? byteLength(input.content) : 0),
    created: booleanValue(raw.created, false),
    overwritten: booleanValue(raw.overwritten, false),
    appended: booleanValue(raw.appended, false),
  }
  if (!ok && error) {
    result.error = error
  }
  const changeSet = normalizeChangeSummary(raw.changeSet ?? raw.change_set)
  if (changeSet) result.changeSet = changeSet
  const changeSummary = normalizeWriteChangeSummary(raw.changeSummary ?? raw.change_summary)
  if (changeSummary) result.changeSummary = changeSummary

  // Reversibility defaults to true only for a successful write the host reported on;
  // a failure never produced a change set.
  const reversible = raw.reversible
  if (typeof reversible === 'boolean') result.reversible = reversible
  const reversibleReason = raw.reversibleReason ?? raw.reversible_reason
  if (typeof reversibleReason === 'string' && reversibleReason.length > 0) {
    result.reversibleReason = reversibleReason
  }
  const dryRun = raw.dryRun ?? raw.dry_run
  if (typeof dryRun === 'boolean') result.dryRun = dryRun
  const wouldChange = raw.wouldChange ?? raw.would_change
  if (typeof wouldChange === 'boolean') result.wouldChange = wouldChange
  return result
}

export async function writeWorkspaceFile(
  input: WorkspaceWriteInput,
  observability: ObservabilityPort = getDefaultObservabilityPort(),
): Promise<WorkspaceWriteResult> {
  if (!hasHostBridge()) {
    return failedResult(input, '写入 workspace 文件：当前宿主未提供命令桥')
  }

  // 惰性加载必须在下面的 dispatchStartedAt 采样之前完成：首次解析宿主 invoke 有几 ms
  // 开销（每个模块实例只发生一次），若落在计时区间里，invokeDispatchMs 报的就不再是「IPC 派发有多慢」
  // 而是「模块加载有多慢」。加载失败复用 invoke 失败的同一条错误出口，返回契约不变——此处尚未
  // beginPerformanceDiagnostic，所以没有需要 finish 的 operation。
  let invoke: Awaited<ReturnType<typeof loadHostInvoke>>
  try {
    invoke = await loadHostInvoke()
  } catch (error) {
    return failedResult(input, `write_workspace_file failed: ${messageFromError(error)}`)
  }

  const context = input.changeContext
  const operation = observability.beginPerformanceDiagnostic(
    'workspace.write.ipc',
    {
      sessionId: context?.sessionId,
      runId: context?.runId,
      toolCallId: context?.toolCallId,
      changeId: context?.changeId,
      path: diagnosticPath(input.path),
      mode: input.mode ?? 'overwrite',
      contentChars: input.content.length,
      expectedOldContentChars: input.expectedOldContent?.length ?? 0,
      createDirs: input.createDirs ?? true,
      exclusivePathLock: input.exclusivePathLock ?? false,
    },
    { operationId: context?.changeId, slowMs: 100 },
  )
  const dispatchStartedAt = observability.performanceNow()
  let invokeDispatchMs = 0
  try {
    const pending = invoke<unknown>(
      'write_workspace_file',
      toTauriInput(input, operation.operationId),
    )
    invokeDispatchMs = observability.performanceNow() - dispatchStartedAt
    const hostWaitStartedAt = observability.performanceNow()
    const raw = await pending
    const hostWaitMs = observability.performanceNow() - hostWaitStartedAt
    const normalizeStartedAt = observability.performanceNow()
    const result = normalizeResult(raw, input)
    const responseNormalizeMs = observability.performanceNow() - normalizeStartedAt
    operation.finish(
      'ok',
      {
        invokeDispatchMs,
        hostWaitMs,
        responseNormalizeMs,
        bytesWritten: result.bytesWritten,
        resultOk: result.ok,
        created: result.created,
        overwritten: result.overwritten,
        appended: result.appended,
        changeSetId: result.changeSet?.id,
      },
    )
    return result
  } catch (error) {
    operation.finish(
      'error',
      {
        invokeDispatchMs,
        hostWaitMs: Math.max(0, observability.performanceNow() - dispatchStartedAt - invokeDispatchMs),
        resultOk: false,
        failureKind: 'invoke_rejected',
      },
      new Error('write_workspace_file invoke rejected'),
    )
    return failedResult(input, `write_workspace_file failed: ${messageFromError(error)}`)
  }
}
