import {
  subagentStatePort,
  type ReadWorkspaceFileInput,
  type ReadWorkspaceFileResult,
  type ReadWorkspaceRunIndexPageInput,
  type ReadWorkspaceRunIndexPageResult,
  type WorkspaceRuntimeResult,
} from '@web-agent/core/subagents'
import { parseJsonl, parseJsonlLines, type JsonlLine } from '../archive/jsonl'
import { replaySubagentArchive, type SubagentReplayState } from '../archive/replay'
import {
  subagentEventsPath,
  subagentIndexPath,
  subagentTracePath,
  subagentTreePath,
} from '../archive/skillCache'

export {
  parseJsonl,
  parseJsonlLines,
  replaySubagentArchive,
  subagentEventsPath,
  subagentIndexPath,
  subagentTracePath,
  subagentTreePath,
}
export type { JsonlLine, SubagentReplayState }

export type ArchiveReader = (
  input: ReadWorkspaceFileInput,
) => Promise<WorkspaceRuntimeResult<ReadWorkspaceFileResult>>

export type RunIndexPageReader = (
  input: ReadWorkspaceRunIndexPageInput,
) => Promise<WorkspaceRuntimeResult<ReadWorkspaceRunIndexPageResult>>

export interface SubagentArchiveText {
  content?: string
  warning?: string
  error?: string
}

export async function readSubagentArchiveFile(
  input: ReadWorkspaceFileInput,
  reader: ArchiveReader = subagentStatePort.readWorkspaceFile,
): Promise<WorkspaceRuntimeResult<ReadWorkspaceFileResult>> {
  return reader(input)
}

export async function readSubagentRunIndexPage(
  input: ReadWorkspaceRunIndexPageInput,
  reader: RunIndexPageReader = subagentStatePort.readWorkspaceRunIndexPage,
): Promise<WorkspaceRuntimeResult<ReadWorkspaceRunIndexPageResult>> {
  return reader(input)
}

async function readSubagentArchiveText(
  reader: ArchiveReader | undefined,
  path: string,
  maxBytes: number,
  workspaceRoot?: string,
): Promise<SubagentArchiveText> {
  const result = await readSubagentArchiveFile({ path, maxBytes, workspaceRoot }, reader)
  if (!result.ok) return { error: result.error }
  return {
    content: result.data.content,
    warning: result.data.truncated ? `${path} 超过 ${maxBytes / 1_000}KB，回放内容已截断` : undefined,
  }
}

export async function readSubagentArchiveDocuments(
  input: { archiveBasePath: string; workspaceRoot?: string },
  reader?: ArchiveReader,
): Promise<{ treeResult: SubagentArchiveText; eventsResult: SubagentArchiveText }> {
  const [treeResult, eventsResult] = await Promise.all([
    readSubagentArchiveText(reader, subagentTreePath(input.archiveBasePath), 200_000, input.workspaceRoot),
    readSubagentArchiveText(reader, subagentEventsPath(input.archiveBasePath), 200_000, input.workspaceRoot),
  ])
  return { treeResult, eventsResult }
}
