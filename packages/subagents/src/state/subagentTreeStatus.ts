import type { SubagentTreeViewNode, SubagentTreeViewStatus } from './subagentViewTypes'

export function aggregateSubagentTreeStatus(
  nodes: SubagentTreeViewNode[],
): SubagentTreeViewStatus {
  if (nodes.some((node) => node.status === 'running' || node.status === 'distilling')) return 'running'
  if (nodes.some((node) => node.status === 'queued')) return 'queued'
  if (nodes.some((node) => node.status === 'interrupted')) return 'interrupted'
  if (nodes.some((node) => node.status === 'failed')) return 'failed'
  if (nodes.some((node) => node.status === 'cancelled')) return 'cancelled'
  return 'done'
}
