// setPlan 的阶段回退点打点（阶段级回退的数据来源）。
// ---------------------------------------------------------------------------
// 打点契约：某阶段从「非 in_progress」转入 in_progress 时，记下**变更前**的计划快照和
// 当时的 items 长度。同一阶段只留最早的一个点（重试/回滚后重开不覆盖），换计划或清空计划时整体清空。
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../runtime/persistenceBridge', () => ({ persistSessions: vi.fn() }))

import { rootStore, sessionsAtom, resetRootStore } from './rootStore'
import { getSessionStore, resetSessionStores } from './sessionStore'
import { itemsAtom, planAtom, planStageCheckpointsAtom } from './sessionAtoms'
import { setPlan } from './planWriters'
import type { ConversationItem, SessionMeta } from './core.type'
import type { PlanSnapshot, PlanStageStatus } from '../planning/types'

afterEach(() => {
  resetSessionStores()
  resetRootStore()
})

const meta: SessionMeta = {
  id: 's1',
  title: 't',
  settings: { vendor: 'deepseek', model: 'x' },
  createdAt: 0,
  updatedAt: 0,
}

function seedSession(itemCount: number): void {
  rootStore.setter(sessionsAtom, { s1: meta })
  const items: ConversationItem[] = Array.from({ length: itemCount }, (_, index) => ({
    id: `i${index}`,
    createdAt: index,
    item: { role: 'assistant', content: `m${index}` },
  }))
  getSessionStore('s1').store.setter(itemsAtom, items)
}

function plan(
  revision: number,
  statuses: PlanStageStatus[],
  id = 'p1',
): PlanSnapshot {
  return {
    schemaVersion: 2,
    id,
    title: 'plan',
    objective: 'o',
    status: 'active',
    revision,
    requiresApproval: false,
    createdAt: 1,
    updatedAt: revision,
    stages: statuses.map((status, index) => ({
      id: `st${index + 1}`,
      title: `阶段 ${index + 1}`,
      objective: 'o',
      deliverables: [],
      acceptanceCriteria: ['c'],
      dependencies: [],
      status,
      evidence: [],
      evaluations: [],
    })),
  }
}

describe('setPlan 的阶段回退点打点', () => {
  it('阶段转 in_progress 时记下变更前的计划快照与当时的 items 长度', () => {
    seedSession(4)
    const before = plan(2, ['pending', 'pending'])
    setPlan('s1', before)
    setPlan('s1', plan(3, ['in_progress', 'pending']))

    const points = getSessionStore('s1').store.getter(planStageCheckpointsAtom)
    expect(points).toHaveLength(1)
    expect(points[0].stageId).toBe('st1')
    expect(points[0].itemCount).toBe(4)
    // 存的是「开始前」的快照：该阶段在其中仍是 pending。
    expect(points[0].plan).toBe(before)
    expect(points[0].plan.stages[0].status).toBe('pending')
  })

  it('同一阶段重新开始不覆盖最早的回退点', () => {
    seedSession(2)
    setPlan('s1', plan(1, ['pending']))
    setPlan('s1', plan(2, ['in_progress']))
    // 阶段失败后被回滚重开：itemCount 已经涨到 9，但回退点必须仍指向第一次开始前。
    seedSession(9)
    rootStore.setter(sessionsAtom, { s1: meta })
    setPlan('s1', plan(3, ['failed']))
    setPlan('s1', plan(4, ['in_progress']))

    const points = getSessionStore('s1').store.getter(planStageCheckpointsAtom)
    expect(points).toHaveLength(1)
    expect(points[0].itemCount).toBe(2)
  })

  it('一次推进同时开启多个阶段时逐个打点', () => {
    seedSession(1)
    setPlan('s1', plan(1, ['pending', 'pending']))
    setPlan('s1', plan(2, ['in_progress', 'in_progress']))

    expect(getSessionStore('s1').store.getter(planStageCheckpointsAtom).map((p) => p.stageId))
      .toEqual(['st1', 'st2'])
  })

  it('计划被清空或换成另一份计划时清空回退点', () => {
    seedSession(3)
    setPlan('s1', plan(1, ['pending']))
    setPlan('s1', plan(2, ['in_progress']))
    expect(getSessionStore('s1').store.getter(planStageCheckpointsAtom)).toHaveLength(1)

    setPlan('s1', plan(1, ['in_progress'], 'p2'))
    expect(getSessionStore('s1').store.getter(planStageCheckpointsAtom)).toEqual([])

    setPlan('s1', plan(2, ['in_progress'], 'p2'))
    setPlan('s1', undefined)
    expect(getSessionStore('s1').store.getter(planStageCheckpointsAtom)).toEqual([])
  })

  it('未登记的会话不打点（ghost guard）', () => {
    getSessionStore('ghost').store.setter(itemsAtom, [])
    setPlan('ghost', plan(2, ['in_progress']))
    expect(getSessionStore('ghost').store.getter(planStageCheckpointsAtom)).toEqual([])
    expect(getSessionStore('ghost').store.getter(planAtom)).toBeUndefined()
  })
})
