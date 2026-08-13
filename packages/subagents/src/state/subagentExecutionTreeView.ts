import type { ExecutionGraphSnapshot, ExecutionNode, ExecutionNodeStatus } from '@web-agent/core/execution/types'
import { parseAgentPath } from '@web-agent/core/subagents/path'
import { isSubagentTraceModelItem } from './subagentTraceAtoms'
import { aggregateSubagentTreeStatus } from './subagentTreeStatus'
import { isRecord, stringList, stringValue, type UnknownRecord } from './subagentViewRecord'
import type {
  SubagentTraceRecord,
  SubagentTreeView,
  SubagentTreeViewNode,
  SubagentTreeViewStatus,
} from './subagentViewTypes'

function executionAgentStatus(status: ExecutionNodeStatus): SubagentTreeViewStatus {
  if (status === 'succeeded') return 'done'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'interrupted') return 'interrupted'
  if (status === 'queued' || status === 'ready') return 'queued'
  return 'running'
}

function executionNodeResult(node: ExecutionNode): UnknownRecord | undefined {
  return isRecord(node.result) ? node.result : undefined
}

function executionAgentPath(node: ExecutionNode): string {
  const result = executionNodeResult(node)
  return stringValue(result?.path)
    ?? (node.id.startsWith(`${node.graphId}:`) ? node.id.slice(node.graphId.length + 1) : node.id)
}

export function deriveExecutionSubagentTrees(
  graph: ExecutionGraphSnapshot,
): SubagentTreeView[] {
  const grouped = new Map<string, ExecutionNode[]>()
  const legacyGraphIds = new Set<string>()
  for (const id of graph.order) {
    const node = graph.nodes[id]
    if (!node || node.type !== 'agent' || executionAgentPath(node) === 'root') continue
    if (!stringValue(executionNodeResult(node)?.delegationCallId)) legacyGraphIds.add(node.graphId)
  }
  for (const id of graph.order) {
    const node = graph.nodes[id]
    if (!node || node.type !== 'agent') continue
    const result = executionNodeResult(node)
    // root 是执行图的调度占位节点，不属于任何一次 delegate_agent。
    // 仅旧会话存在尚未写入 callId 的子节点时保留 root，用来还原重启中断状态；
    // 正常记录若按 graphId 分组，会制造一个无法关联到 tool call 的额外批次。
    if (
      executionAgentPath(node) === 'root' &&
      !stringValue(result?.delegationCallId) &&
      !legacyGraphIds.has(node.graphId)
    ) continue
    const delegationCallId = stringValue(result?.delegationCallId) ?? node.graphId
    const nodes = grouped.get(delegationCallId) ?? []
    nodes.push(node)
    grouped.set(delegationCallId, nodes)
  }

  return [...grouped.entries()].map(([callId, executionNodes]) => {
    const treeId = executionNodes[0]?.graphId ?? callId
    const nodes = executionNodes.map((node): SubagentTreeViewNode => {
      const result = executionNodeResult(node)
      const path = executionAgentPath(node)
      const parent = node.parentId ? graph.nodes[node.parentId] : undefined
      return {
        key: node.id,
        path,
        parentPath: parent ? executionAgentPath(parent) : undefined,
        depth: parseAgentPath(path)?.length ?? (node.parentId ? 1 : 0),
        status: executionAgentStatus(node.status),
        objective: node.label,
        error: node.error,
        resultFile: stringValue(result?.resultFile),
        skillFiles: stringList(result?.skillFiles),
        skillIds: stringList(result?.skillIds),
        trace: node.trace?.filter((record): record is SubagentTraceRecord =>
          isSubagentTraceModelItem(record.item)),
      }
    })
    return {
      id: callId,
      treeId,
      callId,
      createdAt: Math.min(...executionNodes.map((node) => node.createdAt)),
      status: aggregateSubagentTreeStatus(nodes),
      nodes,
      source: 'live' as const,
    }
  }).sort((a, b) => b.createdAt - a.createdAt)
}
