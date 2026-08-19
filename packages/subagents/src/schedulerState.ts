import {
  ROOT_AGENT_PATH,
  agentPathDepth,
  childAgentPath,
  parentAgentPath,
  type ReserveChildrenInput,
  type SubagentNodeRecord,
  type SubagentPath,
  type SubagentScheduler,
} from '@einfach-agent/core/subagents'

interface TreeState {
  treeId: string
  sessionId: string
  nodes: Map<SubagentPath, SubagentNodeRecord>
}

function nodeId(treeId: string, path: SubagentPath): string {
  return `${treeId}:${path}`
}

function createRootNode(treeId: string, sessionId: string): SubagentNodeRecord {
  const now = Date.now()
  return {
    id: nodeId(treeId, ROOT_AGENT_PATH),
    treeId,
    sessionId,
    path: ROOT_AGENT_PATH,
    status: 'running',
    objective: 'root agent',
    dispatchCounter: 0,
    depth: 0,
    childCounter: 0,
    createdAt: now,
    updatedAt: now,
    inheritedSkillFiles: [],
    inheritedSkillIds: [],
    localSkillFiles: [],
    localSkillIds: [],
  }
}

function cloneNode(node: SubagentNodeRecord): SubagentNodeRecord {
  return {
    ...node,
    dispatchCounter: node.dispatchCounter,
    inheritedSkillFiles: [...node.inheritedSkillFiles],
    inheritedSkillIds: [...node.inheritedSkillIds],
    localSkillFiles: [...node.localSkillFiles],
    localSkillIds: [...node.localSkillIds],
  }
}

export function createSubagentScheduler(): SubagentScheduler {
  const trees = new Map<string, TreeState>()
  const listeners = new Set<(node: SubagentNodeRecord) => void>()

  function notify(node: SubagentNodeRecord): void {
    const snapshot = cloneNode(node)
    for (const listener of listeners) listener(snapshot)
  }

  function ensureTree(treeId: string, sessionId: string): TreeState {
    let tree = trees.get(treeId)
    if (!tree) {
      tree = { treeId, sessionId, nodes: new Map() }
      const root = createRootNode(treeId, sessionId)
      tree.nodes.set(ROOT_AGENT_PATH, root)
      trees.set(treeId, tree)
      notify(root)
    }
    return tree
  }

  function ensureParent(
    tree: TreeState,
    path: SubagentPath,
    inheritedSkillFiles: string[],
    inheritedSkillIds: string[],
  ): SubagentNodeRecord {
    let parent = tree.nodes.get(path)
    if (parent) return parent

    const now = Date.now()
    parent = {
      id: nodeId(tree.treeId, path),
      treeId: tree.treeId,
      sessionId: tree.sessionId,
      path,
      parentPath: parentAgentPath(path),
      status: 'running',
      objective: 'parent subagent',
      dispatchCounter: 0,
      depth: agentPathDepth(path),
      childCounter: 0,
      createdAt: now,
      updatedAt: now,
      inheritedSkillFiles,
      inheritedSkillIds,
      localSkillFiles: [],
      localSkillIds: [],
    }
    tree.nodes.set(path, parent)
    notify(parent)
    return parent
  }

  return {
    reserveChildren(input) {
      const tree = ensureTree(input.treeId, input.sessionId)
      const parent = ensureParent(
        tree,
        input.parentPath,
        input.inheritedSkillFiles,
        input.inheritedSkillIds,
      )
      const reserved: SubagentNodeRecord[] = []
      const now = Date.now()
      const dispatchIndex = ++parent.dispatchCounter
      parent.updatedAt = now
      notify(parent)

      for (const child of input.children) {
        parent.childCounter += 1
        const path = childAgentPath(input.parentPath, parent.childCounter)
        const record: SubagentNodeRecord = {
          id: nodeId(input.treeId, path),
          treeId: input.treeId,
          sessionId: input.sessionId,
          path,
          parentPath: input.parentPath,
          status: 'queued',
          objective: child.objective,
          mode: child.mode,
          expectedOutput: child.expectedOutput,
          delegationCallId: input.delegationCallId,
          depth: agentPathDepth(path),
          dispatchCounter: 0,
          childCounter: 0,
          createdAt: now,
          updatedAt: now,
          inheritedSkillFiles: [...input.inheritedSkillFiles],
          inheritedSkillIds: [...input.inheritedSkillIds],
          localSkillFiles: [],
          localSkillIds: [],
        }
        tree.nodes.set(path, record)
        notify(record)
        reserved.push(cloneNode(record))
      }

      return reserved
    },
    markNode(treeId, path, status, patch) {
      const tree = trees.get(treeId)
      const node = tree?.nodes.get(path)
      if (!node) return undefined
      Object.assign(node, patch ?? {}, { status, updatedAt: Date.now() })
      notify(node)
      return cloneNode(node)
    },
    snapshot(treeId) {
      const tree = trees.get(treeId)
      return tree ? Array.from(tree.nodes.values(), cloneNode) : []
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
