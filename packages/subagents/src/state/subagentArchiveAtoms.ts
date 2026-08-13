import { atom } from '@einfach/core'
import { createLatestOnlyLoader } from './createLatestOnlyLoader'
import { isMissingSubagentArchiveError } from './subagentArchiveErrors'
import {
  readSubagentArchiveDocuments,
  replaySubagentArchive,
  subagentEventsPath,
  type ArchiveReader,
  type SubagentReplayState,
} from './subagentArchiveReader'
import { aggregateSubagentTreeStatus } from './subagentTreeStatus'
import type {
  SubagentArchiveLoadState,
  SubagentTreeView,
  SubagentTreeViewNode,
} from './subagentViewTypes'

function replayTreeView(
  archiveBasePath: string,
  replay: SubagentReplayState,
  warnings: string[],
): SubagentTreeView | undefined {
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
    status: aggregateSubagentTreeStatus(nodes),
    archiveBasePath,
    nodes,
    source: 'archive',
    eventLog: subagentEventsPath(archiveBasePath),
    warnings,
  }
}

export async function readSubagentArchive(
  input: { archiveBasePath: string; workspaceRoot?: string },
  reader?: ArchiveReader,
): Promise<SubagentArchiveLoadState> {
  const { treeResult, eventsResult } = await readSubagentArchiveDocuments(input, reader)
  if (!treeResult.content && !eventsResult.content) {
    const errors = [treeResult.error, eventsResult.error].filter((value): value is string => Boolean(value))
    return {
      ...input,
      status: errors.length > 0 && errors.every(isMissingSubagentArchiveError) ? 'empty' : 'error',
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

export const subagentArchiveLoadsAtom = atom<Record<string, SubagentArchiveLoadState>>({})
const subagentArchiveLoader = createLatestOnlyLoader<string>()

export const loadSubagentArchiveAtom = atom(
  null,
  async (get, set, input: { archiveBasePath: string; workspaceRoot?: string; force?: boolean; reader?: ArchiveReader }) => {
    const current = get(subagentArchiveLoadsAtom)[input.archiveBasePath]
    if (!input.force && current && current.workspaceRoot === input.workspaceRoot) return
    const token = subagentArchiveLoader.start(get, set, input.archiveBasePath)
    set(subagentArchiveLoadsAtom, {
      ...get(subagentArchiveLoadsAtom),
      [input.archiveBasePath]: {
        archiveBasePath: input.archiveBasePath,
        workspaceRoot: input.workspaceRoot,
        status: 'loading',
      },
    })
    const loaded = await readSubagentArchive(input, input.reader)
    if (!subagentArchiveLoader.isLatest(get, token, input.archiveBasePath)) return
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
