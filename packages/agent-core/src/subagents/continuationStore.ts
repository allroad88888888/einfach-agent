import type { CoreInstance } from '../runtime/core/coreInstance'
import { subagentContinuationsAtom } from '../state/subagentContinuationAtoms'
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
  const store = input.core.getSessionStore(input.sessionId).store
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
  store.setter(subagentContinuationsAtom, (previous) => {
    const linked = parentNodeId
      ? previous.map((item) => item.childId === parentNodeId
        ? updateDescriptor(item, (descriptor) => appendNestedChildIds(descriptor, childIds))
        : item)
      : previous
    return [...linked, ...queued]
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
  const store = input.core.getSessionStore(input.sessionId).store
  const current = store.getter(subagentContinuationsAtom)
  const continuation = current.find((item) => item.childId === input.childId)
  const descriptor = continuation ? readChildContinuationDescriptor(continuation) : undefined
  if (!continuation || !descriptor || descriptor.lifecycle !== 'active' || continuation.state !== 'queued') return false
  store.setter(subagentContinuationsAtom, (previous) => previous.map((item) => item.childId === input.childId
    ? { ...item, state: 'outcome_unknown', spec: childContinuationDescriptorJson(fenceChildContinuationDescriptor(descriptor)) }
    : item))
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
  const store = input.core.getSessionStore(input.sessionId).store
  const current = store.getter(subagentContinuationsAtom)
  const continuation = current.find((item) => item.childId === input.childId)
  const descriptor = continuation && readChildContinuationDescriptor(continuation)
  if (!continuation || !descriptor || descriptor.lifecycle !== 'active') {
    throw new Error('active child continuation is missing')
  }
  store.setter(subagentContinuationsAtom, (previous) => previous.map((item) => item.childId === input.childId
    ? {
        ...item,
        state: 'interrupted',
        spec: childContinuationDescriptorJson(terminalChildContinuationDescriptor({ descriptor, ...input })),
      }
    : item))
}

function updateDescriptor(
  continuation: SubagentContinuationV1,
  update: (descriptor: ChildContinuationDescriptor) => ChildContinuationDescriptor,
): SubagentContinuationV1 {
  const descriptor = readChildContinuationDescriptor(continuation)
  if (!descriptor || descriptor.lifecycle !== 'active') throw new Error('parent child continuation is not active')
  return { ...continuation, spec: childContinuationDescriptorJson(update(descriptor)) }
}
