// 执行图槽位的增量记账 —— 只记被动过的那几个节点。
// ---------------------------------------------------------------------------
// 与 sessionItemsLog.ts 同一个理由，不同的形状。执行图的节点带 `trace?: ExecutionTraceRecord[]`，
// 而 `ExecutionTraceRecord.item` 是一条**完整模型消息**（可含工具结果），且 `node.trace` 事件按
// `[...(current.trace ?? []), event.record]` 每节点无界追加。所以整值记账下每来一个 trace 事件，
// 都要把整张图（含所有节点的全部 trace）存进日志两遍 —— 又是 `cap × 累积内容` 的二次开销。
//
// 增量的形状取节点粒度：reducer 是不可变复制，没动过的节点**引用相同**，于是「改了哪些节点」
// 用 `Object.is` 逐 id 比一遍就得到，不必让 reducer 额外汇报，也不需要深比较。
// `order` 单独带上（一串 id，小）。`version` 在类型上就是字面量 `1`，不可能变，故不记。
//
// 逆操作是把记下的那几个 id 合并回当前图：`null` 表示「那一刻这个 id 不存在」，回放时删掉它。
// 用 `null` 而不是 `undefined`：这份载荷要过 JSON，`undefined` 在序列化时会整个键消失，
// 于是「删掉这个节点」和「没提到这个节点」就分不开了。

import type { ExecutionGraphSnapshot, ExecutionNode } from '../execution/types'
import { executionGraphAtom } from '../execution/graph'
import type { Getter, History, Setter } from '@einfach/core'
import { inTurnTransaction, type SlotWriteTarget } from './sessionSlotWrite'

/** 会进落盘记录的逻辑名，改名等于改格式。 */
export const EXECUTION_GRAPH_NODES_KEY = 'executionGraph:nodes'

/** 一次图变更里被动过的部分。`null` = 那一刻该 id 不存在。 */
interface ExecutionGraphPatch {
  nodes: Record<string, ExecutionNode | null>
  /** 仅在 order 真的变了时出现；缺席表示「保持当前 order」。 */
  order?: string[]
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left === right
    || (left.length === right.length && left.every((id, index) => id === right[index]))
}

function diff(
  current: ExecutionGraphSnapshot,
  next: ExecutionGraphSnapshot,
): { before: ExecutionGraphPatch; after: ExecutionGraphPatch; changed: boolean } {
  const before: ExecutionGraphPatch = { nodes: {} }
  const after: ExecutionGraphPatch = { nodes: {} }
  let changed = false
  for (const id of new Set([...Object.keys(current.nodes), ...Object.keys(next.nodes)])) {
    const previous = current.nodes[id]
    const updated = next.nodes[id]
    // reducer 不可变复制：引用相同 = 这个节点这次没被动过。
    if (Object.is(previous, updated)) continue
    changed = true
    before.nodes[id] = previous ?? null
    after.nodes[id] = updated ?? null
  }
  if (!sameOrder(current.order, next.order)) {
    changed = true
    before.order = [...current.order]
    after.order = [...next.order]
  }
  return { before, after, changed }
}

function applier(
  getter: Getter,
  setter: Setter,
  op: { before: unknown; after: unknown },
  direction: 'undo' | 'redo',
): boolean {
  const patch = (direction === 'undo' ? op.before : op.after) as ExecutionGraphPatch
  if (!patch || typeof patch !== 'object' || !patch.nodes) return false
  const graph = getter(executionGraphAtom) as ExecutionGraphSnapshot
  const nodes = { ...graph.nodes }
  for (const [id, node] of Object.entries(patch.nodes)) {
    if (node === null) delete nodes[id]
    else nodes[id] = node
  }
  setter(executionGraphAtom, () => ({ ...graph, nodes, order: patch.order ?? graph.order }))
  return true
}

/** 把执行图的增量还原方式登记进一本日志。 */
export function registerExecutionGraphAppliers(history: History): void {
  history.registerApplier(EXECUTION_GRAPH_NODES_KEY, applier)
}

/**
 * 用 reducer 推进执行图，并只记被动过的那几个节点的账。
 *
 * 收 reducer 而不是收结果：算出的新图要与「拿它和旧图做 diff」是同一次运算的产物，
 * 分成两步会给出「调用方传进来的 next 其实不是从当前图算出来的」这种对不上的可能。
 */
export function writeExecutionGraph(
  target: SlotWriteTarget,
  reduce: (graph: ExecutionGraphSnapshot) => ExecutionGraphSnapshot,
): void {
  const current = target.store.getter(executionGraphAtom) as ExecutionGraphSnapshot
  const next = reduce(current)
  if (Object.is(current, next)) return
  const { before, after, changed } = diff(current, next)
  // 图对象换了但节点与 order 都没动（reducer 复制了一层却什么也没改）：写回去，但不占一步 undo。
  if (!changed) {
    target.store.setter(executionGraphAtom, () => next)
    return
  }
  inTurnTransaction(target, () => {
    target.store.setter(executionGraphAtom, () => next)
    target.history.record({ key: EXECUTION_GRAPH_NODES_KEY, before, after })
  })
}
