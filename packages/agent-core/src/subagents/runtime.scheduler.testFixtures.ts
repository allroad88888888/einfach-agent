// core 内核测试用的内存子 agent 调度器。
// ---------------------------------------------------------------------------
// 内核测试要断言的是 core 自己的子 run 机制读到了什么树状态（预留出来的路径、状态位、
// dispatchCounter），不是产品调度器的实现。这里只保留「够断言」的一份：树内计数 + 状态位 +
// 订阅。产品实现（`packages/subagents`）的语义由它自己的测试守，这里不复制。

import type { SubagentScheduler } from '../runtime/delegationContract'
import { agentPathDepth, childAgentPath, parentAgentPath, ROOT_AGENT_PATH } from './path'
import type { SubagentNodeRecord, SubagentNodeStatus, SubagentPath } from './types'

function testNode(input: {
  treeId: string
  sessionId: string
  path: SubagentPath
  objective: string
  status: SubagentNodeStatus
  inheritedSkillFiles?: readonly string[]
  inheritedSkillIds?: readonly string[]
}): SubagentNodeRecord {
  const now = Date.now()
  return {
    id: `${input.treeId}:${input.path}`,
    treeId: input.treeId,
    sessionId: input.sessionId,
    path: input.path,
    parentPath: parentAgentPath(input.path),
    status: input.status,
    objective: input.objective,
    depth: agentPathDepth(input.path),
    dispatchCounter: 0,
    childCounter: 0,
    createdAt: now,
    updatedAt: now,
    inheritedSkillFiles: [...(input.inheritedSkillFiles ?? [])],
    inheritedSkillIds: [...(input.inheritedSkillIds ?? [])],
    localSkillFiles: [],
    localSkillIds: [],
  }
}

/** 单进程内存调度器：预留子节点、记状态、发通知，够 core 读 snapshot 与写 tree.json。 */
export function createTestScheduler(): SubagentScheduler {
  const trees = new Map<string, Map<SubagentPath, SubagentNodeRecord>>()
  const listeners = new Set<(node: SubagentNodeRecord) => void>()

  function notify(node: SubagentNodeRecord): void {
    for (const listener of listeners) listener({ ...node })
  }

  function ensureTree(treeId: string, sessionId: string): Map<SubagentPath, SubagentNodeRecord> {
    const existing = trees.get(treeId)
    if (existing) return existing
    const nodes = new Map<SubagentPath, SubagentNodeRecord>()
    const root = testNode({
      treeId,
      sessionId,
      path: ROOT_AGENT_PATH,
      objective: 'root agent',
      status: 'running',
    })
    nodes.set(ROOT_AGENT_PATH, root)
    trees.set(treeId, nodes)
    notify(root)
    return nodes
  }

  return {
    reserveChildren(input) {
      const nodes = ensureTree(input.treeId, input.sessionId)
      let parent = nodes.get(input.parentPath)
      if (!parent) {
        parent = testNode({
          treeId: input.treeId,
          sessionId: input.sessionId,
          path: input.parentPath,
          objective: 'parent subagent',
          status: 'running',
          inheritedSkillFiles: input.inheritedSkillFiles,
          inheritedSkillIds: input.inheritedSkillIds,
        })
        nodes.set(input.parentPath, parent)
      }
      const owner = parent
      owner.dispatchCounter += 1
      owner.updatedAt = Date.now()
      notify(owner)

      return input.children.map((child) => {
        owner.childCounter += 1
        const record: SubagentNodeRecord = {
          ...testNode({
            treeId: input.treeId,
            sessionId: input.sessionId,
            path: childAgentPath(input.parentPath, owner.childCounter),
            objective: child.objective,
            status: 'queued',
            inheritedSkillFiles: input.inheritedSkillFiles,
            inheritedSkillIds: input.inheritedSkillIds,
          }),
          mode: child.mode,
          expectedOutput: child.expectedOutput,
          delegationCallId: input.delegationCallId,
        }
        nodes.set(record.path, record)
        notify(record)
        return { ...record }
      })
    },
    markNode(treeId, path, status, patch) {
      const node = trees.get(treeId)?.get(path)
      if (!node) return undefined
      Object.assign(node, patch ?? {}, { status, updatedAt: Date.now() })
      notify(node)
      return { ...node }
    },
    snapshot(treeId) {
      return Array.from(trees.get(treeId)?.values() ?? [], (node) => ({ ...node }))
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    clear(treeId) {
      trees.delete(treeId)
    },
  }
}
