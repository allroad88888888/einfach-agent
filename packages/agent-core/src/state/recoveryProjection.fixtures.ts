// recoveryProjection 各测试共用的种子状态与捕获入口。
// 只造数据，不做断言：allowlist 新增字段时改这里一处，所有投影测试同步覆盖到。

import { createStore, type Store } from '@einfach/core'
import { executionGraphAtom } from '../execution/graph'
import type { ExecutionGraphSnapshot } from '../execution/types'
import { sessionsAtom } from './rootAtoms'
import { captureRecoverySnapshot } from './recoveryProjection'
import type { RecoverySnapshotV1 } from './recoverySnapshot.type'
import {
  contextCheckpointAtom,
  itemsAtom,
  planAtom,
  planStageCheckpointsAtom,
  runAtom,
} from './sessionAtoms'
import {
  composerDraftAtom,
  pendingArtifactsAtom,
  pendingQuestionAnswersAtom,
  queuedUserMessagesAtom,
} from './sessionTransientAtoms'
import { subagentContinuationsAtom } from './subagentContinuationAtoms'

export const sessionId = 'session-recovery'

export const recoverySession = {
  id: sessionId,
  title: 'Recovery session',
  // 中性厂商名：本文件不是 *.test.ts，受 core 厂商名红线约束，而 codec 只要求 vendor 是字符串。
  settings: { vendor: 'test-vendor', model: 'test-model' },
  createdAt: 1,
  updatedAt: 2,
}

export function plan(id = 'plan-1') {
  return {
    schemaVersion: 4 as const,
    id,
    title: 'Recover work',
    objective: 'Resume exactly',
    status: 'active' as const,
    revision: 2,
    requiresApproval: false,
    createdAt: 10,
    updatedAt: 11,
    stages: [{
      id: 'stage-1',
      title: 'Implement',
      objective: 'write code',
      deliverables: ['code'],
      dependencies: [],
      status: 'in_progress' as const,
      evidence: [],
    }],
  }
}

export function graph(id = 'node-1'): ExecutionGraphSnapshot {
  return {
    version: 1,
    nodes: {
      [id]: {
        id,
        graphId: 'graph-1',
        sessionId,
        runId: 'run-1',
        dependsOn: [],
        type: 'agent',
        status: 'interrupted',
        label: 'child work',
        attempt: 1,
        generation: 1,
        effectKeys: ['child:one'],
        createdAt: 20,
        updatedAt: 21,
      },
    },
    order: [id],
  }
}

export function seedDurableState(store: Store): void {
  const currentPlan = plan()
  store.setter(itemsAtom, [{
    id: 'item-1',
    createdAt: 1,
    item: { role: 'user', content: 'continue my task' },
  }])
  store.setter(contextCheckpointAtom, {
    schemaVersion: 1,
    summary: 'Earlier work',
    coveredItemIds: ['item-1'],
    createdAt: 2,
    sourceEstimatedTokens: 3,
  })
  store.setter(planAtom, currentPlan)
  store.setter(planStageCheckpointsAtom, [{
    stageId: 'stage-1',
    plan: currentPlan,
    itemCount: 1,
    createdAt: 12,
  }])
  store.setter(runAtom, {
    runId: 'run-1',
    status: 'waiting_user',
    startedAt: 4,
    turnId: 'item-1',
    pendingExecutionId: 'process-only-handle',
    pendingQuestion: { questionId: 'ask-1' },
    pendingUserDecision: {
      callId: 'call-1',
      payload: { questionId: 'ask-1' },
      origin: { surface: 'conversation', phase: 'executing' },
    },
  })
  store.setter(queuedUserMessagesAtom, [{
    id: 'queued-1',
    createdAt: 5,
    content: 'Queued while waiting',
    targetRunId: 'run-1',
    submissionSequence: 4,
  }])
  store.setter(pendingQuestionAnswersAtom, { 'ask-1': ['first', 'second'] })
  store.setter(pendingArtifactsAtom, [{
    id: 'artifact-1',
    filename: 'report.md',
    content: '# 只活在这个 atom 里的产物内容',
    mimeType: 'text/markdown',
  }])
  store.setter(composerDraftAtom, 'withdrawn user words')
  store.setter(executionGraphAtom, graph())
  store.setter(subagentContinuationsAtom, [{
    schemaVersion: 1,
    childId: 'child-1',
    parentRunId: 'run-1',
    parentNodeId: 'node-1',
    state: 'waiting_user',
    spec: { task: 'audit the implementation' },
  }])
}

export function capture(store: Store): RecoverySnapshotV1 {
  const rootStore = createStore()
  rootStore.setter(sessionsAtom, { [sessionId]: recoverySession })
  return captureRecoverySnapshot(store, { rootStore, sessionId, generation: 7, capturedAt: 99 })
}
