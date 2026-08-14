import type {
  ListWorkspaceFilesInput,
  ListWorkspaceFilesResult,
  ReadWorkspaceFileInput,
  ReadWorkspaceFileResult,
  ReadWorkspaceRunIndexPageInput,
  ReadWorkspaceRunIndexPageResult,
  SearchWorkspaceFilesInput,
  SearchWorkspaceFilesResult,
  WorkspaceFileEntry,
  WorkspaceJsonlLine,
  WorkspaceRuntimeResult,
  WorkspaceSearchMatch,
} from '../runtime/workspaceRead'
import type { RgSearchInput, RgSearchMatch, RgSearchResult } from '../runtime/workspaceRg'
import type {
  WorkspacePatchFileChange,
  WorkspacePatchInput,
  WorkspacePatchOperation,
  WorkspacePatchRejected,
  WorkspacePatchResult,
} from '../runtime/workspacePatch'
import type {
  WorkspaceChangeConflict,
  WorkspaceChangeContext,
  WorkspaceChangeSummary,
  WorkspaceRevertInput,
  WorkspaceRevertResult,
} from '../runtime/workspaceChange'
import type { ObservabilityPort } from '../observability/port'

export type {
  ListWorkspaceFilesInput,
  ListWorkspaceFilesResult,
  ReadWorkspaceFileInput,
  ReadWorkspaceFileResult,
  ReadWorkspaceRunIndexPageInput,
  ReadWorkspaceRunIndexPageResult,
  RgSearchInput,
  RgSearchMatch,
  RgSearchResult,
  SearchWorkspaceFilesInput,
  SearchWorkspaceFilesResult,
  WorkspaceChangeConflict,
  WorkspaceChangeContext,
  WorkspaceChangeSummary,
  WorkspaceFileEntry,
  WorkspaceJsonlLine,
  WorkspacePatchFileChange,
  WorkspacePatchInput,
  WorkspacePatchOperation,
  WorkspacePatchRejected,
  WorkspacePatchResult,
  WorkspaceRevertInput,
  WorkspaceRevertResult,
  WorkspaceRuntimeResult,
  WorkspaceSearchMatch,
}

// Keep importing @web-agent/core/tools side-effect free: standard tool registration runs
// before individual runtime tests install their exact hostTauri mocks.
export async function readWorkspaceFile(
  input: ReadWorkspaceFileInput,
): Promise<WorkspaceRuntimeResult<ReadWorkspaceFileResult>> {
  return (await import('../runtime/workspaceRead')).readWorkspaceFile(input)
}

export async function readWorkspaceRunIndexPage(
  input: ReadWorkspaceRunIndexPageInput,
): Promise<WorkspaceRuntimeResult<ReadWorkspaceRunIndexPageResult>> {
  return (await import('../runtime/workspaceRead')).readWorkspaceRunIndexPage(input)
}

export async function listWorkspaceFiles(
  input: ListWorkspaceFilesInput,
): Promise<WorkspaceRuntimeResult<ListWorkspaceFilesResult>> {
  return (await import('../runtime/workspaceRead')).listWorkspaceFiles(input)
}

export async function searchWorkspaceFiles(
  input: SearchWorkspaceFilesInput,
): Promise<WorkspaceRuntimeResult<SearchWorkspaceFilesResult>> {
  return (await import('../runtime/workspaceRead')).searchWorkspaceFiles(input)
}

export const DEFAULT_RG_MAX_MATCHES = 200
export const MAX_RG_MATCHES = 1_000
export const DEFAULT_RG_CONTEXT_LINES = 0
export const MAX_RG_CONTEXT_LINES = 5

export async function rgSearchWorkspace(input: RgSearchInput): Promise<RgSearchResult> {
  return (await import('../runtime/workspaceRg')).rgSearchWorkspace(input)
}

export async function applyWorkspacePatch(
  input: WorkspacePatchInput,
  observability?: ObservabilityPort,
): Promise<WorkspacePatchResult> {
  return (await import('../runtime/workspacePatch')).applyWorkspacePatch(input, observability)
}

export function normalizeChangeSummary(value: unknown): WorkspaceChangeSummary | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const candidate = value as Record<string, unknown>
  if (typeof candidate.id !== 'string' || typeof candidate.reversible !== 'boolean') {
    return undefined
  }
  return { id: candidate.id, reversible: candidate.reversible }
}

export async function revertWorkspaceChange(
  input: WorkspaceRevertInput,
): Promise<WorkspaceRevertResult> {
  return (await import('../runtime/workspaceChange')).revertWorkspaceChange(input)
}
