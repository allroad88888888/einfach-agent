import { atom } from '@einfach/core'
import { subagentStatePort } from '@einfach-agent/core/subagents'
import { archiveSubagentTreesAtom } from './subagentArchiveAtoms'
import {
  globalSubagentRunsAtom,
  selectedGlobalSubagentRunAtom,
} from './subagentRunHistoryAtoms'
import { deriveSubagentTrees } from './subagentConversationTreeView'
import { deriveExecutionSubagentTrees } from './subagentExecutionTreeView'
import { reconcileSubagentTrees } from './subagentTreeReconciliation'

export type { RunIndexPageReader } from './subagentArchiveReader'
export type {
  GlobalSubagentRun,
  GlobalSubagentRunSelection,
  GlobalSubagentRunsState,
  SubagentArchiveLoadState,
  SubagentArchiveLoadStatus,
  SubagentArchivePreviewState,
  SubagentTraceRecord,
  SubagentTraceState,
  SubagentTreeView,
  SubagentTreeViewNode,
  SubagentTreeViewStatus,
} from './subagentViewTypes'
export { deriveSubagentTrees, deriveExecutionSubagentTrees }
export {
  archiveSubagentTreesAtom,
  loadSubagentArchiveAtom,
  readSubagentArchive,
  subagentArchiveLoadsAtom,
} from './subagentArchiveAtoms'
export {
  loadSubagentArchivePreviewAtom,
  resolveSubagentArchivePath,
  subagentArchivePreviewAtom,
} from './subagentArchivePreviewAtoms'
export {
  globalSubagentRunsAtom,
  loadGlobalSubagentRunsAtom,
  parseGlobalSubagentRunsIndex,
  readGlobalSubagentRunsPage,
  selectedGlobalSubagentRunAtom,
} from './subagentRunHistoryAtoms'
export {
  loadSubagentTraceAtom,
  parseSubagentTrace,
  subagentTraceAtom,
} from './subagentTraceAtoms'

export const subagentTreesAtom = atom((get) => {
  const executionTrees = deriveExecutionSubagentTrees(get(subagentStatePort.executionGraphAtom))
  const conversationTrees = deriveSubagentTrees(get(subagentStatePort.itemsAtom))
  return reconcileSubagentTrees(executionTrees, conversationTrees)
})

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
