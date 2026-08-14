import { describe, expect, it } from 'vitest'

import { decodeRecoverySnapshot } from './recoverySnapshot.codec'
import {
  RECOVERY_SNAPSHOT_COMMIT_MARKER,
  RECOVERY_SNAPSHOT_SCHEMA_VERSION,
  type RecoverySnapshotV1,
} from './recoverySnapshot.type'

type LooseRecord = Record<string, unknown>

function samplePlan() {
  return {
    schemaVersion: 4 as const,
    id: 'plan-1',
    title: '恢复任务',
    objective: '从中断点继续',
    status: 'active' as const,
    revision: 3,
    requiresApproval: false,
    createdAt: 10,
    updatedAt: 20,
    stages: [{
      id: 'stage-1',
      title: '实现',
      objective: '完成实现',
      deliverables: ['source'],
      dependencies: [],
      status: 'in_progress' as const,
      evidence: [],
    }],
  }
}

function snapshot(): RecoverySnapshotV1 {
  const plan = samplePlan()
  return {
    schemaVersion: RECOVERY_SNAPSHOT_SCHEMA_VERSION,
    sessionId: 'session-1',
    capturedAt: 6,
    generation: 7,
    commitMarker: RECOVERY_SNAPSHOT_COMMIT_MARKER,
    session: {
      id: 'session-1',
      title: '恢复中的会话',
      settings: {
        vendor: 'deepseek',
        model: 'deepseek-v4-pro',
        thinking: true,
        temperature: 0.3,
        max_tokens: 4_000,
        vendorSettings: { region: 'cn' },
      },
      createdAt: 1,
      updatedAt: 5,
      workspaceId: 'workspace-1',
      workspaceRoot: '/workspace',
      toolApprovalMode: 'auto',
      loadedTools: ['read_file'],
    },
    values: {
      conversation: {
        items: [{
          id: 'user-1',
          createdAt: 1,
          item: { role: 'user', content: '继续所有子任务' },
          planStageId: 'stage-1',
        }],
        contextCheckpoint: {
          schemaVersion: 1,
          summary: '已有进度',
          coveredItemIds: ['user-1'],
          createdAt: 2,
          sourceEstimatedTokens: 9,
        },
      },
      plan: {
        current: plan,
        stageCheckpoints: [{ stageId: 'stage-1', plan, itemCount: 1, createdAt: 3 }],
      },
      run: {
        runId: 'run-1',
        status: 'waiting_user',
        turnId: 'user-1',
        pendingQuestion: { questions: [{ id: 'q1', question: '继续？' }] },
      },
      queuedUserMessages: [{ id: 'queue-1', createdAt: 4, content: '补充', targetRunId: 'run-1' }],
      pendingQuestionAnswers: { q1: ['继续', '保留子 agent'] },
      executionGraph: {
        version: 1,
        nodes: {
          'child-1': {
            id: 'child-1',
            graphId: 'graph-1',
            sessionId: 'session-1',
            runId: 'run-1',
            dependsOn: [],
            type: 'agent',
            status: 'interrupted',
            label: '子 agent',
            attempt: 1,
            generation: 2,
            effectKeys: [],
            createdAt: 1,
            updatedAt: 5,
          },
        },
        order: ['child-1'],
      },
      subagentContinuations: [{
        schemaVersion: 1,
        childId: 'child-1',
        parentRunId: 'run-1',
        parentNodeId: null,
        state: 'interrupted',
        spec: { objective: '完成子任务', maxTurns: 4 },
      }],
    },
  }
}

function changed(change: (raw: LooseRecord) => void): unknown {
  const raw = structuredClone(snapshot()) as unknown as LooseRecord
  change(raw)
  return raw
}

function values(raw: LooseRecord): LooseRecord {
  return raw.values as LooseRecord
}

describe('RecoverySnapshotV1', () => {
  it('接受包含全部 durable atom 投影的 JSON 往返快照', () => {
    const original = snapshot()
    const text = JSON.stringify(original)
    const decoded = decodeRecoverySnapshot(JSON.parse(text))

    expect(decoded).toEqual(original)
    expect(decoded?.session).toEqual(original.session)
    expect(decoded?.values.pendingQuestionAnswers).toEqual({ q1: ['继续', '保留子 agent'] })
    expect(decoded?.values.subagentContinuations[0]?.childId).toBe('child-1')
  })

  it('只接受规范的每工具调用结果事实', () => {
    const valid = snapshot()
    valid.values.run = {
      runId: 'run-1',
      status: 'interrupted',
      toolCallOutcomes: {
        'call-1': { state: 'notStarted', updatedAt: 8 },
        'call-2': { state: 'outcomeUnknown', updatedAt: 9 },
        'call-3': { state: 'outcomeKnown', updatedAt: 10 },
      },
    }

    expect(decodeRecoverySnapshot(valid)?.values.run?.toolCallOutcomes).toEqual(valid.values.run.toolCallOutcomes)

    const malformed = structuredClone(valid) as unknown as LooseRecord
    ;((values(malformed).run as LooseRecord).toolCallOutcomes as LooseRecord)[''] = { state: 'outcomeKnown', updatedAt: 1 }
    expect(decodeRecoverySnapshot(malformed)).toBeUndefined()
  })

  it('只允许 values.subagentContinuations 作为 child 续接真源', () => {
    const original = snapshot()

    expect('continuation' in original).toBe(false)
    expect(decodeRecoverySnapshot({ ...original, continuation: { child: 'child-1' } })).toBeUndefined()
  })

  it.each([
    ['未知未来 schema', { ...snapshot(), schemaVersion: 2 }],
    ['旧空记录', {}],
    ['generation 不是非负安全整数', { ...snapshot(), generation: -1 }],
    ['缺失完整提交 marker', { ...snapshot(), commitMarker: 'writing' }],
    ['缺失根会话静态投影', (() => {
      const raw = snapshot() as unknown as LooseRecord
      delete raw.session
      return raw
    })()],
  ])('拒绝%s', (_label, malformed) => {
    expect(decodeRecoverySnapshot(malformed)).toBeUndefined()
  })

  it.each([
    ['不完整 plan.current', (raw: LooseRecord) => { (values(raw).plan as LooseRecord).current = { id: 'partial' } }],
    ['不合法 conversation ModelItem', (raw: LooseRecord) => { ((values(raw).conversation as LooseRecord).items as LooseRecord[])[0].item = { role: 'user', content: 9 } }],
    ['不合法 pending question answer', (raw: LooseRecord) => { values(raw).pendingQuestionAnswers = { q1: [1] } }],
    ['不合法 queued message 内容', (raw: LooseRecord) => { (values(raw).queuedUserMessages as LooseRecord[])[0].content = [{ type: 'text', text: 9 }] }],
    ['不合法 run status', (raw: LooseRecord) => { (values(raw).run as LooseRecord).status = 'unknown' }],
    ['不合法 graph node shell', (raw: LooseRecord) => {
      const nodes = (values(raw).executionGraph as LooseRecord).nodes as LooseRecord
      ;(nodes['child-1'] as LooseRecord).status = 'unknown'
    }],
    ['graph order 漏掉 node', (raw: LooseRecord) => { (values(raw).executionGraph as LooseRecord).order = [] }],
    ['graph order 重复 node', (raw: LooseRecord) => { (values(raw).executionGraph as LooseRecord).order = ['child-1', 'child-1'] }],
    ['graph node 跨 session', (raw: LooseRecord) => {
      const nodes = (values(raw).executionGraph as LooseRecord).nodes as LooseRecord
      ;(nodes['child-1'] as LooseRecord).sessionId = 'session-2'
    }],
    ['重复 subagent childId', (raw: LooseRecord) => {
      const continuations = values(raw).subagentContinuations as LooseRecord[]
      continuations.push({ ...continuations[0], state: 'queued' })
    }],
    ['session id 不匹配', (raw: LooseRecord) => { (raw.session as LooseRecord).id = 'session-2' }],
    ['不完整 session settings', (raw: LooseRecord) => { delete ((raw.session as LooseRecord).settings as LooseRecord).model }],
    ['session 混入动态 plan', (raw: LooseRecord) => { (raw.session as LooseRecord).plan = samplePlan() }],
    ['session 混入动态 executionGraph', (raw: LooseRecord) => {
      ;(raw.session as LooseRecord).executionGraph = values(raw).executionGraph
    }],
  ])('拒绝%s', (_label, change) => {
    expect(decodeRecoverySnapshot(changed(change))).toBeUndefined()
  })

  it('拒绝 live execution handle、函数和循环引用', () => {
    const liveHandle = changed((raw) => { (values(raw).run as LooseRecord).pendingExecutionId = 'live-process' })
    const functionPayload = changed((raw) => { (values(raw).subagentContinuations as LooseRecord[])[0].spec = () => undefined })
    const cyclicPayload = changed((raw) => {
      const spec: LooseRecord = {}
      spec.self = spec
      ;(values(raw).subagentContinuations as LooseRecord[])[0].spec = spec
    })
    const sessionFunction = changed((raw) => {
      ;((raw.session as LooseRecord).settings as LooseRecord).vendorSettings = { normalize: () => undefined }
    })
    const sessionCycle = changed((raw) => {
      const vendorSettings: LooseRecord = {}
      vendorSettings.self = vendorSettings
      ;((raw.session as LooseRecord).settings as LooseRecord).vendorSettings = vendorSettings
    })

    expect(decodeRecoverySnapshot(liveHandle)).toBeUndefined()
    expect(decodeRecoverySnapshot(functionPayload)).toBeUndefined()
    expect(decodeRecoverySnapshot(cyclicPayload)).toBeUndefined()
    expect(decodeRecoverySnapshot(sessionFunction)).toBeUndefined()
    expect(decodeRecoverySnapshot(sessionCycle)).toBeUndefined()
  })
})
