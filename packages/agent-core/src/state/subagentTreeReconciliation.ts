import type { SubagentTreeView } from './subagentViewTypes'

function overlapScore(
  executionTree: SubagentTreeView,
  conversationTree: SubagentTreeView,
): number {
  if (executionTree.treeId !== conversationTree.treeId) return 0
  const paths = new Set(conversationTree.nodes.map((node) => node.path))
  return executionTree.nodes.reduce(
    (score, node) => score + (paths.has(node.path) ? 1 : 0),
    0,
  )
}

export function reconcileSubagentTrees(
  executionTrees: SubagentTreeView[],
  conversationTrees: SubagentTreeView[],
): SubagentTreeView[] {
  const usedConversationCallIds = new Set<string>()
  const reconciledExecutionTrees = executionTrees.map((tree) => {
    // 旧会话的首个 children_reserved 快照可能尚未带 delegationCallId；
    // 用同一 treeId 下的节点 path 将其重新关联到原始 delegate_agent 调用。
    if (tree.callId !== tree.treeId) {
      usedConversationCallIds.add(tree.callId)
      return tree
    }
    let bestMatch: SubagentTreeView | undefined
    let bestScore = 0
    for (const candidate of conversationTrees) {
      if (usedConversationCallIds.has(candidate.callId)) continue
      const score = overlapScore(tree, candidate)
      if (score > bestScore) {
        bestMatch = candidate
        bestScore = score
      }
    }
    if (!bestMatch) return tree
    usedConversationCallIds.add(bestMatch.callId)
    return {
      ...tree,
      id: bestMatch.callId,
      callId: bestMatch.callId,
      strategy: bestMatch.strategy,
      archiveBasePath: bestMatch.archiveBasePath,
      eventLog: bestMatch.eventLog,
    }
  })

  const executionCallIds = new Set(reconciledExecutionTrees.map((tree) => tree.callId))
  return [
    ...reconciledExecutionTrees,
    ...conversationTrees.filter((tree) => !executionCallIds.has(tree.callId)),
  ].sort((a, b) => b.createdAt - a.createdAt)
}
