import { atom } from '@einfach/core'
import { createLatestOnlyLoader } from './createLatestOnlyLoader'
import { readSubagentArchiveFile, type ArchiveReader } from './subagentArchiveReader'
import type { SubagentArchivePreviewState } from './subagentViewTypes'

export const subagentArchivePreviewAtom = atom<SubagentArchivePreviewState>({ status: 'idle' })
const subagentArchivePreviewLoader = createLatestOnlyLoader()

export function resolveSubagentArchivePath(archiveBasePath: string, path: string): string {
  const normalized = path.replace(/^\.\//, '')
  if (normalized === archiveBasePath || normalized.startsWith(`${archiveBasePath}/`) || normalized.startsWith('.webAgent-archive/')) {
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
    const token = subagentArchivePreviewLoader.start(_get, set)
    set(subagentArchivePreviewAtom, { status: 'loading', kind: input.kind, path, nodeKey: input.nodeKey })
    if (input.content !== undefined) {
      set(subagentArchivePreviewAtom, { status: 'ready', kind: input.kind, path, nodeKey: input.nodeKey, content: input.content })
      return
    }
    const result = await readSubagentArchiveFile(
      { path, maxBytes: 200_000, workspaceRoot: input.workspaceRoot },
      input.reader,
    )
    if (!subagentArchivePreviewLoader.isLatest(_get, token)) return
    set(subagentArchivePreviewAtom, result.ok
      ? { status: 'ready', kind: input.kind, path, nodeKey: input.nodeKey, content: result.data.content }
      : { status: 'error', kind: input.kind, path, nodeKey: input.nodeKey, error: result.error })
  },
)
