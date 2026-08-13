import type { ModelItem } from '@web-agent/ai'
import { parseAgentPath } from '@web-agent/core/subagents'
import { aggregateSubagentTreeStatus } from './subagentTreeStatus'
import {
  isRecord,
  parseRecord,
  stringList,
  stringValue,
  subagentNodeStatus,
  type UnknownRecord,
} from './subagentViewRecord'
import type {
  SubagentTreeView,
  SubagentTreeViewNode,
  SubagentTreeViewStatus,
} from './subagentViewTypes'

interface ConversationItem {
  item: ModelItem
  createdAt: number
}

function toolResults(items: ConversationItem[]): Map<string, UnknownRecord> {
  const results = new Map<string, UnknownRecord>()
  for (const { item } of items) {
    if (item.role !== 'tool') continue
    const value = parseRecord(item.content)
    if (value) results.set(item.tool_call_id, value)
  }
  return results
}

function resultNodes(result: UnknownRecord, treeId: string): SubagentTreeViewNode[] {
  if (!Array.isArray(result.children)) return []
  return result.children.flatMap((value) => {
    if (!isRecord(value)) return []
    const path = stringValue(value.path)
    if (!path) return []
    return [{
      key: `${treeId}:${path}`,
      path,
      parentPath: stringValue(result.parentPath),
      // 归档路径使用 root-01-02，而不是点号分隔；非法旧数据仍作为直属节点安全展示。
      depth: parseAgentPath(path)?.length ?? 1,
      status: subagentNodeStatus(value.status, 'done'),
      objective: stringValue(value.objective) ?? '未命名任务',
      summary: stringValue(value.summary),
      error: stringValue(value.error),
      resultFile: stringValue(value.resultFile),
      skillFiles: stringList(value.skillFiles),
      skillIds: stringList(value.skillIds),
    }]
  })
}

function pendingNodes(
  args: UnknownRecord | undefined,
  treeId: string,
  status: SubagentTreeViewStatus = 'queued',
  error?: string,
): SubagentTreeViewNode[] {
  if (!args || !Array.isArray(args.children)) return []
  return args.children.flatMap((value, index) => {
    if (!isRecord(value)) return []
    const objective = stringValue(value.objective)
    if (!objective) return []
    const path = `pending-${index + 1}`
    return [{
      key: `${treeId}:${path}`,
      path,
      parentPath: 'root',
      depth: 1,
      status,
      objective,
      error,
      skillFiles: [],
      skillIds: [],
    }]
  })
}

export function deriveSubagentTrees(items: ConversationItem[]): SubagentTreeView[] {
  const results = toolResults(items)
  const trees: SubagentTreeView[] = []

  for (const conversationItem of items) {
    const item = conversationItem.item
    if (item.role !== 'assistant') continue
    for (const call of item.tool_calls ?? []) {
      if (call.function.name !== 'delegate_agent') continue
      const args = parseRecord(call.function.arguments)
      const result = results.get(call.id)
      const treeId = stringValue(result?.treeId) ?? stringValue(result?.graphId) ?? call.id
      const batchId = call.id
      const children = resultNodes(result ?? {}, batchId)
      const error = stringValue(result?.error)
      const nodes = children.length > 0
        ? children
        : pendingNodes(args, batchId, error ? 'failed' : 'queued', error)
      const rootStatus: SubagentTreeViewStatus = error
        ? 'failed'
        : result
          ? aggregateSubagentTreeStatus(nodes)
          : 'running'
      const root: SubagentTreeViewNode = {
        key: `${batchId}:root`,
        path: stringValue(result?.parentPath) ?? 'root',
        depth: 0,
        status: rootStatus,
        objective: `委派 ${nodes.length} 个子 agent`,
        error,
        skillFiles: stringList(result?.skillFiles),
        skillIds: stringList(result?.skillIds),
      }
      trees.push({
        id: batchId,
        treeId,
        callId: call.id,
        createdAt: conversationItem.createdAt,
        status: rootStatus,
        strategy: stringValue(result?.strategy) ?? stringValue(args?.strategy),
        archiveBasePath: stringValue(result?.archiveBasePath),
        nodes: [root, ...nodes],
        source: 'live',
        eventLog: stringValue(result?.eventLog),
      })
    }
  }

  return trees.sort((a, b) => b.createdAt - a.createdAt)
}
