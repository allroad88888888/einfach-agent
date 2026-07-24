import { createStore } from '@einfach/core'
import { describe, expect, it } from 'vitest'
import {
  activeExecutionNodeIdsAtom,
  createExecutionNode,
  executionGraphAtom,
  readyExecutionNodeIdsAtom,
  reduceExecutionGraph,
} from './graph'

describe('execution graph', () => {
  it('ignores stale node completions from an older attempt', () => {
    const node = { ...createExecutionNode({
      id: 'n1',
      graphId: 'g1',
      sessionId: 's1',
      runId: 'r1',
      type: 'agent',
      label: 'child',
      now: 1,
    }), attempt: 2 }
    const graph = reduceExecutionGraph(
      { version: 1, nodes: {}, order: [] },
      { type: 'node.added', node },
    )
    const next = reduceExecutionGraph(graph, {
      type: 'node.status',
      nodeId: 'n1',
      status: 'succeeded',
      at: 2,
      attempt: 1,
      generation: 1,
      result: 'stale',
    })
    expect(next).toBe(graph)
  })

  it('derives ready nodes from dependency completion', () => {
    const store = createStore()
    const dependency = {
      ...createExecutionNode({
        id: 'a',
        graphId: 'g',
        sessionId: 's',
        runId: 'r',
        type: 'tool',
        label: 'read',
      }),
      status: 'succeeded' as const,
    }
    const dependent = {
      ...createExecutionNode({
        id: 'b',
        graphId: 'g',
        sessionId: 's',
        runId: 'r',
        type: 'tool',
        label: 'write',
        dependsOn: ['a'],
      }),
      status: 'ready' as const,
    }
    store.setter(executionGraphAtom, {
      version: 1,
      nodes: { a: dependency, b: dependent },
      order: ['a', 'b'],
    })
    expect(store.getter(readyExecutionNodeIdsAtom)).toEqual(['b'])
    expect(store.getter(activeExecutionNodeIdsAtom)).toEqual(['b'])
  })

  it('marks persisted active nodes interrupted on hydrate', () => {
    const node = {
      ...createExecutionNode({
        id: 'n',
        graphId: 'g',
        sessionId: 's',
        runId: 'r',
        type: 'agent',
        label: 'running child',
      }),
      status: 'running' as const,
    }
    const graph = reduceExecutionGraph(
      { version: 1, nodes: { n: node }, order: ['n'] },
      { type: 'graph.hydrated', at: 10 },
    )
    expect(graph.nodes.n.status).toBe('interrupted')
  })

  it('keeps child model and tool trace when the node status changes', () => {
    const node = createExecutionNode({
      id: 'run:root-01',
      graphId: 'run',
      sessionId: 'session',
      runId: 'run',
      type: 'agent',
      label: 'inspect runtime',
      now: 1,
    })
    const graph = reduceExecutionGraph(
      { version: 1, nodes: {}, order: [] },
      { type: 'node.added', node },
    )
    const withTrace = reduceExecutionGraph(graph, {
      type: 'node.trace',
      nodeId: node.id,
      record: {
        timestamp: '2026-07-23T05:00:00.000Z',
        turn: 1,
        item: {
          role: 'assistant',
          content: null,
          reasoning_content: '先检查执行图。',
          tool_calls: [{
            id: 'read-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"runtime.ts"}' },
          }],
        },
      },
    })
    const completed = reduceExecutionGraph(withTrace, {
      type: 'node.status',
      nodeId: node.id,
      status: 'succeeded',
      at: 3,
      attempt: 1,
      generation: 1,
      result: { path: 'root-01' },
    })

    expect(completed.nodes[node.id].trace).toEqual([
      expect.objectContaining({
        turn: 1,
        item: expect.objectContaining({
          role: 'assistant',
          reasoning_content: '先检查执行图。',
        }),
      }),
    ])
  })
})
