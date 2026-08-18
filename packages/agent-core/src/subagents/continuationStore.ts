import type { CoreInstance } from '../runtime/core/coreInstance'
import { inTurnTransaction } from '../state/sessionSlotWrite'
import { subagentContinuationsAtom } from '../state/subagentContinuationAtoms'
import {
  appendSubagentContinuationLogged,
  patchSubagentContinuationLogged,
} from '../state/subagentContinuationsLog'
import type { SubagentContinuationV1 } from '../state/recoverySnapshot.type'
import {
  appendNestedChildIds,
  childContinuationDescriptorJson,
  createChildContinuationDescriptor,
  fenceChildContinuationDescriptor,
  terminalChildContinuationDescriptor,
  type ChildContinuationDescriptor,
} from './continuationDescriptor'
import { readChildContinuationDescriptor } from './continuationDescriptorParser'
import type { DelegateAgentChildSpec, SubagentNodeRecord } from './types'

const queuedBatchToken = Symbol('queuedChildContinuationBatch')

/** A short-lived capability proving this process just durably queued a child. */
export interface QueuedChildContinuationBatch {
  readonly [queuedBatchToken]: true
  consume(childId: string): boolean
}

function createQueuedBatch(childIds: readonly string[]): QueuedChildContinuationBatch {
  const remaining = new Set(childIds)
  return {
    [queuedBatchToken]: true,
    consume(childId) {
      if (!remaining.has(childId)) return false
      remaining.delete(childId)
      return true
    },
  }
}

/** Mutates the one session atom that owns recoverable child continuation state. */
export function queueChildContinuations(input: {
  core: CoreInstance
  sessionId: string
  nodes: readonly SubagentNodeRecord[]
  specs: readonly DelegateAgentChildSpec[]
}): QueuedChildContinuationBatch {
  if (input.nodes.length !== input.specs.length) throw new Error('child continuation node/spec mismatch')
  if (input.nodes.length === 0) return createQueuedBatch([])
  const session = input.core.getSessionStore(input.sessionId)
  const store = session.store
  const current = store.getter(subagentContinuationsAtom)
  const childIds = input.nodes.map((node) => node.id)
  if (new Set(childIds).size !== childIds.length || current.some((item) => childIds.includes(item.childId))) {
    throw new Error('child continuation already exists')
  }
  const first = input.nodes[0]
  if (!first || !input.nodes.every((node) => node.treeId === first.treeId && node.parentPath === first.parentPath)) {
    throw new Error('child continuation batch must share one parent')
  }
  const parentNodeId = first.parentPath && first.parentPath !== 'root'
    ? `${first.treeId}:${first.parentPath}`
    : null
  if (parentNodeId && !current.some((item) => item.childId === parentNodeId)) {
    throw new Error('parent child continuation is missing')
  }
  const queued = input.nodes.map((node, index): SubagentContinuationV1 => ({
    schemaVersion: 1,
    childId: node.id,
    parentRunId: node.treeId,
    parentNodeId: node.parentPath && node.parentPath !== 'root' ? `${node.treeId}:${node.parentPath}` : null,
    state: 'queued',
    spec: childContinuationDescriptorJson(createChildContinuationDescriptor(node, input.specs[index]!)),
  }))
  // 一次 queueChildContinuations 调用 = 一步 undo：父节点的 patch 与全部新条目的 append
  // 包进同一个事务，逆操作会按栈序整批退回，不会出现「撤销时只退回一半子任务」的半截状态。
  inTurnTransaction(session, () => {
    if (parentNodeId) {
      const parent = current.find((item) => item.childId === parentNodeId)
      // 上面已经校验过 parentNodeId 存在于 current，这里只是让 TS 知道；真正不存在时不会走到这。
      if (!parent) throw new Error('parent child continuation is missing')
      const linked = updateDescriptor(parent, (descriptor) => appendNestedChildIds(descriptor, childIds))
      patchSubagentContinuationLogged(session, parentNodeId, { spec: linked.spec })
    }
    for (const item of queued) {
      appendSubagentContinuationLogged(session, item)
    }
  })
  return createQueuedBatch(childIds)
}

/** Fences only a child created by the current delegation call before model work starts. */
export function fenceChildContinuation(input: {
  core: CoreInstance
  sessionId: string
  childId: string
  queuedBatch: QueuedChildContinuationBatch
}): boolean {
  if (!input.queuedBatch.consume(input.childId)) return false
  const session = input.core.getSessionStore(input.sessionId)
  const store = session.store
  const current = store.getter(subagentContinuationsAtom)
  const continuation = current.find((item) => item.childId === input.childId)
  const descriptor = continuation ? readChildContinuationDescriptor(continuation) : undefined
  if (!continuation || !descriptor || descriptor.lifecycle !== 'active' || continuation.state !== 'queued') return false
  patchSubagentContinuationLogged(session, input.childId, {
    state: 'outcome_unknown',
    spec: childContinuationDescriptorJson(fenceChildContinuationDescriptor(descriptor)),
  })
  return true
}

/** Records a completed child result without removing it before its parent tool result is durable. */
export function markChildContinuationTerminal(input: {
  core: CoreInstance
  sessionId: string
  childId: string
  kind: 'done' | 'failed' | 'cancelled'
  summary: string
  resultArchivePath: string | undefined
  skillFiles: string[]
  skillIds: string[]
  changeSets: Array<{ id: string; reversible: boolean }>
}): void {
  const session = input.core.getSessionStore(input.sessionId)
  const store = session.store
  const current = store.getter(subagentContinuationsAtom)
  const continuation = current.find((item) => item.childId === input.childId)
  const descriptor = continuation && readChildContinuationDescriptor(continuation)
  if (!continuation || !descriptor || descriptor.lifecycle !== 'active') {
    throw new Error('active child continuation is missing')
  }
  // 注意：这里是 patch，不是移除 —— 终态条目要保留到父聚合边界才清（见本文件同名测试用例
  // 「retains terminal output ... until a later parent aggregation boundary」），移除逻辑还没实现。
  patchSubagentContinuationLogged(session, input.childId, {
    state: 'interrupted',
    spec: childContinuationDescriptorJson(terminalChildContinuationDescriptor({ descriptor, ...input })),
  })
}

function updateDescriptor(
  continuation: SubagentContinuationV1,
  update: (descriptor: ChildContinuationDescriptor) => ChildContinuationDescriptor,
): SubagentContinuationV1 {
  const descriptor = readChildContinuationDescriptor(continuation)
  if (!descriptor || descriptor.lifecycle !== 'active') throw new Error('parent child continuation is not active')
  return { ...continuation, spec: childContinuationDescriptorJson(update(descriptor)) }
}
