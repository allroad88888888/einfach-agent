import { atom } from '@einfach/core'
import type {
  ExecutionEvent,
  ExecutionGraphSnapshot,
  ExecutionNode,
  ExecutionNodeStatus,
} from './types'

export const EMPTY_EXECUTION_GRAPH: ExecutionGraphSnapshot = {
  version: 1,
  nodes: {},
  order: [],
}

export const executionGraphAtom = atom<ExecutionGraphSnapshot>(EMPTY_EXECUTION_GRAPH)
export const executionEventsAtom = atom<ExecutionEvent[]>([])

const READY_DEPENDENCY_STATUSES = new Set<ExecutionNodeStatus>(['succeeded'])
const ACTIVE_STATUSES = new Set<ExecutionNodeStatus>([
  'queued',
  'ready',
  'running',
  'waiting-children',
  'waiting-user',
])
const TERMINAL_STATUSES = new Set<ExecutionNodeStatus>(['succeeded', 'failed', 'cancelled'])

export const readyExecutionNodeIdsAtom = atom((get) => {
  const graph = get(executionGraphAtom)
  return graph.order.filter((id) => {
    const node = graph.nodes[id]
    return node?.status === 'ready'
      && node.dependsOn.every((dependencyId) =>
        READY_DEPENDENCY_STATUSES.has(graph.nodes[dependencyId]?.status),
      )
  })
})

export const activeExecutionNodeIdsAtom = atom((get) => {
  const graph = get(executionGraphAtom)
  return graph.order.filter((id) => ACTIVE_STATUSES.has(graph.nodes[id]?.status))
})

export function reduceExecutionGraph(
  graph: ExecutionGraphSnapshot,
  event: ExecutionEvent,
): ExecutionGraphSnapshot {
  if (event.type === 'graph.hydrated') {
    let changed = false
    const nodes = { ...graph.nodes }
    for (const id of graph.order) {
      const node = nodes[id]
      if (!node || !ACTIVE_STATUSES.has(node.status)) continue
      changed = true
      const { finishedAt: _finishedAt, error: _error, ...activeNode } = node
      nodes[id] = {
        ...activeNode,
        status: 'interrupted',
        updatedAt: event.at,
      }
    }
    return changed ? { ...graph, nodes } : graph
  }

  if (event.type === 'node.added') {
    if (graph.nodes[event.node.id]) return graph
    return {
      ...graph,
      nodes: { ...graph.nodes, [event.node.id]: event.node },
      order: [...graph.order, event.node.id],
    }
  }

  const current = graph.nodes[event.nodeId]
  if (!current) return graph
  if (event.type === 'node.trace') {
    return {
      ...graph,
      nodes: {
        ...graph.nodes,
        [current.id]: {
          ...current,
          updatedAt: Date.parse(event.record.timestamp) || current.updatedAt,
          trace: [...(current.trace ?? []), event.record],
        },
      },
    }
  }
  if (current.attempt !== event.attempt || current.generation !== event.generation) {
    return graph
  }
  // Terminal state is monotonic. In particular, a task that ignores AbortSignal
  // must not overwrite an already-dispatched cancellation when it resolves later.
  if (TERMINAL_STATUSES.has(current.status)) {
    return graph
  }

  const terminal = TERMINAL_STATUSES.has(event.status)
  const startedAt = event.status === 'running'
    ? current.startedAt ?? event.at
    : current.startedAt
  const {
    finishedAt: _finishedAt,
    result: _result,
    error: _error,
    ...nodeWithoutOutcome
  } = current
  return {
    ...graph,
    nodes: {
      ...graph.nodes,
      [current.id]: {
        ...nodeWithoutOutcome,
        status: event.status,
        updatedAt: event.at,
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(terminal ? { finishedAt: event.at } : {}),
        ...(event.result === undefined ? {} : { result: event.result }),
        ...(event.error === undefined ? {} : { error: event.error }),
      },
    },
  }
}

export function createExecutionNode(input: {
  id: string
  graphId: string
  sessionId: string
  runId: string
  type: ExecutionNode['type']
  label: string
  parentId?: string
  dependsOn?: string[]
  effectKeys?: string[]
  now?: number
}): ExecutionNode {
  const now = input.now ?? Date.now()
  return {
    id: input.id,
    graphId: input.graphId,
    sessionId: input.sessionId,
    runId: input.runId,
    ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
    dependsOn: input.dependsOn ?? [],
    type: input.type,
    status: 'queued',
    label: input.label,
    attempt: 1,
    generation: 1,
    effectKeys: input.effectKeys ?? [],
    createdAt: now,
    updatedAt: now,
  }
}
