import { describe, expect, it } from 'vitest'
import type { JsonValue, SubagentContinuationV1 } from '../state/recoverySnapshot.type'
import {
  childContinuationDescriptorJson,
  createChildContinuationDescriptor,
  terminalChildContinuationDescriptor,
} from './continuationDescriptor'
import { parseChildContinuation, readChildContinuationDescriptor } from './continuationDescriptorParser'
import type { DelegateAgentChildSpec, SubagentNodeRecord } from './types'

const task: DelegateAgentChildSpec = {
  objective: 'verify recovery behavior',
  modelTier: 'pro',
  taskCategory: 'verification',
  confirmedTools: ['write_file'],
}

function node(path = 'root-01', parentPath = 'root'): SubagentNodeRecord {
  return {
    id: `run-1:${path}`,
    treeId: 'run-1',
    sessionId: 'session-1',
    path,
    parentPath,
    delegationCallId: 'delegate-call-1',
    status: 'queued',
    objective: task.objective,
    depth: path.split('-').length - 1,
    dispatchCounter: 0,
    childCounter: 0,
    createdAt: 1,
    updatedAt: 1,
    inheritedSkillFiles: [],
    inheritedSkillIds: [],
    localSkillFiles: [],
    localSkillIds: [],
  }
}

function continuation(input: {
  state?: SubagentContinuationV1['state']
  descriptor?: ReturnType<typeof createChildContinuationDescriptor>
} = {}): SubagentContinuationV1 {
  const current = node()
  return {
    schemaVersion: 1,
    childId: current.id,
    parentRunId: current.treeId,
    parentNodeId: null,
    state: input.state ?? 'queued',
    spec: childContinuationDescriptorJson(input.descriptor ?? createChildContinuationDescriptor(current, task)),
  }
}

function activeSpec(): Record<string, JsonValue> {
  return {
    version: 1,
    parent: { path: 'root', delegationCallId: 'delegate-call-1' },
    task: { objective: task.objective },
    lifecycle: 'active',
    resumePolicy: 'requires_reconciliation',
    knownToolOutcome: { kind: 'none' },
    nestedChildIds: [],
  }
}

function terminalSpec(): Record<string, JsonValue> {
  return {
    ...activeSpec(),
    lifecycle: 'terminal',
    knownToolOutcome: { kind: 'unknown', reason: 'child_execution_started' },
    terminal: {
      kind: 'done',
      summary: 'child completed',
      resultArchivePath: 'archive/child.md',
      deliverables: {
        skillFiles: ['skills/child.md'],
        skillIds: ['skill-1'],
        changeSets: [{ id: 'change-1', reversible: true }],
      },
    },
  }
}

describe('child continuation descriptor recovery parser', () => {
  it('never marks restored queued or outcome-unknown work runnable', () => {
    expect(parseChildContinuation(continuation())).toEqual({
      kind: 'requires_reconciliation',
      reason: 'child execution requires reconciliation',
    })
    expect(parseChildContinuation(continuation({ state: 'outcome_unknown' }))).toEqual({
      kind: 'requires_reconciliation',
      reason: 'child execution requires reconciliation',
    })
  })

  it('preserves explicit user waits but treats terminal records as delivery-only', () => {
    expect(parseChildContinuation(continuation({ state: 'waiting_user' }))).toEqual({ kind: 'await_input' })
    const active = createChildContinuationDescriptor(node(), task)
    const terminal = terminalChildContinuationDescriptor({
      descriptor: active,
      kind: 'done',
      summary: 'child completed',
      resultArchivePath: 'archive/child.md',
      skillFiles: ['skills/child.md'],
      skillIds: ['skill-1'],
      changeSets: [{ id: 'change-1', reversible: true }],
    })
    const restored = continuation({ state: 'interrupted', descriptor: terminal })

    expect(parseChildContinuation(restored)).toEqual({ kind: 'deliver_terminal' })
    expect(readChildContinuationDescriptor(restored)).toMatchObject({
      parent: { path: 'root', delegationCallId: 'delegate-call-1' },
      lifecycle: 'terminal',
      terminal: {
        resultArchivePath: 'archive/child.md',
        deliverables: { changeSets: [{ id: 'change-1', reversible: true }] },
      },
    })
  })

  it('fails closed for malformed parent correlation or nested lineage', () => {
    const badCorrelation: SubagentContinuationV1 = {
      ...continuation(),
      spec: {
        version: 1,
        parent: { path: 'root', delegationCallId: '' },
        task: { objective: task.objective },
        lifecycle: 'active',
        resumePolicy: 'requires_reconciliation',
        knownToolOutcome: { kind: 'none' },
        nestedChildIds: [],
      },
    }
    const badNested: SubagentContinuationV1 = {
      ...continuation(),
      spec: {
        version: 1,
        parent: { path: 'root', delegationCallId: 'delegate-call-1' },
        task: { objective: task.objective },
        lifecycle: 'active',
        resumePolicy: 'requires_reconciliation',
        knownToolOutcome: { kind: 'none' },
        nestedChildIds: ['run-1:root-02'],
      },
    }

    expect(parseChildContinuation(badCorrelation)).toMatchObject({ kind: 'requires_reconciliation' })
    expect(parseChildContinuation(badNested)).toMatchObject({ kind: 'requires_reconciliation' })
  })

  const unknownFieldCases: Array<[
    layer: string,
    state: SubagentContinuationV1['state'],
    spec: Record<string, JsonValue>,
  ]> = [
    ['top-level', 'queued', { ...activeSpec(), unexpected: true }],
    ['parent', 'queued', { ...activeSpec(), parent: { path: 'root', delegationCallId: 'delegate-call-1', unexpected: true } }],
    ['task', 'queued', { ...activeSpec(), task: { objective: task.objective, unexpected: true } }],
    ['known outcome', 'queued', { ...activeSpec(), knownToolOutcome: { kind: 'none', unexpected: true } }],
    ['terminal', 'interrupted', { ...terminalSpec(), terminal: {
      kind: 'done', summary: 'child completed', resultArchivePath: 'archive/child.md',
      deliverables: { skillFiles: [], skillIds: [], changeSets: [] }, unexpected: true,
    } }],
    ['terminal deliverables', 'interrupted', { ...terminalSpec(), terminal: {
      kind: 'done', summary: 'child completed', resultArchivePath: 'archive/child.md',
      deliverables: { skillFiles: [], skillIds: [], changeSets: [], unexpected: true },
    } }],
    ['terminal change set', 'interrupted', { ...terminalSpec(), terminal: {
      kind: 'done', summary: 'child completed', resultArchivePath: 'archive/child.md',
      deliverables: { skillFiles: [], skillIds: [], changeSets: [{ id: 'change-1', reversible: true, unexpected: true }] },
    } }],
  ]

  it.each(unknownFieldCases)('rejects unknown %s descriptor fields', (_layer, state, spec) => {
    const malformed: SubagentContinuationV1 = { ...continuation(), state, spec }

    expect(readChildContinuationDescriptor(malformed)).toBeUndefined()
    expect(parseChildContinuation(malformed)).toEqual({ kind: 'requires_reconciliation', reason: 'invalid child descriptor' })
  })
})
