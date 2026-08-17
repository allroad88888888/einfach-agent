import { describe, expect, it } from 'vitest'
import { createCore } from '../runtime/core/createCore'
import { executionGraphAtom } from '../execution/graph'
import type { ExecutionGraphSnapshot, ExecutionNode } from '../execution/types'
import { writeExecutionGraph } from './executionGraphSlotLog'

function seeded() {
  const core = createCore()
  const id = core.newSession({ settings: { vendor: 'test', model: 'test-model' } })
  core.selectSession(id)
  return { core, id, session: core.getSessionStore(id) }
}

function node(id: string, patch: Partial<ExecutionNode> = {}): ExecutionNode {
  return {
    id,
    graphId: 'g1',
    sessionId: 's1',
    runId: 'r1',
    dependsOn: [],
    type: 'tool',
    status: 'queued',
    label: id,
    attempt: 1,
    generation: 1,
    effectKeys: [],
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

function graph(nodes: ExecutionNode[]): ExecutionGraphSnapshot {
  return {
    version: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    order: nodes.map((entry) => entry.id),
  }
}

/** 一个带大量 trace 的节点 —— 模拟累积了整轮模型消息的子 Agent 节点。 */
function heavy(id: string, records: number): ExecutionNode {
  return node(id, {
    trace: Array.from({ length: records }, (_, index) => ({
      timestamp: `t${index}`,
      turn: index,
      item: { role: 'tool' as const, tool_call_id: `c${index}`, content: 'x'.repeat(4096) },
    })),
  })
}

function lastOpBytes(session: { history: { getState(): { entries: readonly { ops: unknown }[] } } }): number {
  const { entries } = session.history.getState()
  return JSON.stringify(entries[entries.length - 1]?.ops).length
}

describe('执行图记账的大小', () => {
  it('改一个节点的账不含没被动过的节点', () => {
    // 整值记账下这条必挂：before/after 各存一份完整图，含 heavy 节点的全部 trace。
    function bytesWithNeighbour(records: number): number {
      const { session } = seeded()
      session.store.setter(executionGraphAtom, () => graph([heavy('big', records), node('small')]))
      writeExecutionGraph(session, (current) => ({
        ...current,
        nodes: { ...current.nodes, small: { ...current.nodes.small!, status: 'running' } },
      }))
      return lastOpBytes(session)
    }
    expect(bytesWithNeighbour(200)).toBe(bytesWithNeighbour(1))
    expect(bytesWithNeighbour(200)).toBeLessThan(2048)
  })
})

describe('执行图的逆操作', () => {
  it('撤销改回被动过的那个节点，不碰邻居', () => {
    const { core, session } = seeded()
    session.store.setter(executionGraphAtom, () => graph([node('a'), node('b')]))
    writeExecutionGraph(session, (current) => ({
      ...current,
      nodes: { ...current.nodes, a: { ...current.nodes.a!, status: 'succeeded' } },
    }))
    expect(session.store.getter(executionGraphAtom).nodes.a!.status).toBe('succeeded')

    expect(core.undoEntry()).toEqual({ ok: true, entries: 1 })
    const after = session.store.getter(executionGraphAtom)
    expect(after.nodes.a!.status).toBe('queued')
    expect(after.nodes.b!.status).toBe('queued')

    expect(core.redoEntry()).toEqual({ ok: true, entries: 1 })
    expect(session.store.getter(executionGraphAtom).nodes.a!.status).toBe('succeeded')
  })

  it('撤销新增的节点会把它删掉，并退回旧 order', () => {
    const { core, session } = seeded()
    session.store.setter(executionGraphAtom, () => graph([node('a')]))
    writeExecutionGraph(session, (current) => ({
      ...current,
      nodes: { ...current.nodes, b: node('b') },
      order: [...current.order, 'b'],
    }))

    expect(core.undoEntry()).toEqual({ ok: true, entries: 1 })
    const after = session.store.getter(executionGraphAtom)
    // null 载荷的意义就在这里：「这个 id 当时不存在」必须能与「没提到这个 id」区分开。
    expect(Object.keys(after.nodes)).toEqual(['a'])
    expect(after.order).toEqual(['a'])

    expect(core.redoEntry()).toEqual({ ok: true, entries: 1 })
    expect(Object.keys(session.store.getter(executionGraphAtom).nodes).sort()).toEqual(['a', 'b'])
  })

  it('节点与 order 都没变时写回值但不占一步 undo', () => {
    const { session } = seeded()
    session.store.setter(executionGraphAtom, () => graph([node('a')]))
    const before = session.history.getState().entries.length

    // reducer 复制了一层外壳却什么也没改（图对象换了，Object.is 为假）。
    writeExecutionGraph(session, (current) => ({ ...current }))

    expect(session.history.getState().entries.length).toBe(before)
  })
})
