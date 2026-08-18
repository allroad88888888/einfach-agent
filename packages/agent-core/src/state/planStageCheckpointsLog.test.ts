// planStageCheckpoints 槽位增量记账 —— 覆盖 append 的账本大小与撤销行为。
// ---------------------------------------------------------------------------
// 机制本身（逆操作凭什么是对的、为什么要按 id 校验）在 listSlotLog.ts；两个先例
// sessionItemsLog.test.ts / pendingArtifactsLog.test.ts 已经把通用部分测过，本文件只覆盖
// planStageCheckpoints 这个实例特有的东西。
//
// 只测 append：这个槽位目前只有 append 一种增量 op（见 planStageCheckpointsLog.ts 顶部注释，
// 整体清空/整体截断仍走整值 applier），没有 patch/remove，所以不存在「按 id 查找失败则不记账」
// 的场景。换成两条覆盖同一个意图（「不该记账的时候真的不记账」）：redo 方向的尾部重复保护，
// 以及 setPlan 上游按 stageId 去重后连 append 都不会被触发。

import { describe, expect, it } from 'vitest'
import { createCore } from '../runtime/core/createCore'
import type { PlanSnapshot, PlanStageStatus } from '../planning/types'
import type { PlanStageCheckpoint } from './planStageCheckpoint.type'
import { planStageCheckpointsAtom } from './sessionAtoms'
import { appendPlanStageCheckpointLogged } from './planStageCheckpointsLog'
import { setPlan } from './planWriters'

type Core = ReturnType<typeof createCore>

function seeded() {
  const core = createCore()
  const id = core.newSession({ settings: { vendor: 'test', model: 'test-model' } })
  core.selectSession(id)
  return { core, id, session: core.getSessionStore(id) }
}

/** 一个装了 padBytes 字节 objective 的假回退点，只用来量账本大小，不追求业务语义真实。 */
function checkpoint(stageId: string, padBytes = 8): PlanStageCheckpoint {
  return {
    stageId,
    plan: {
      schemaVersion: 4,
      id: 'p1',
      title: 'plan',
      objective: 'x'.repeat(padBytes),
      status: 'active',
      revision: 1,
      requiresApproval: false,
      createdAt: 1,
      updatedAt: 1,
      stages: [],
    },
    itemCount: 0,
    createdAt: 1,
  }
}

function stageIds(core: Core, id: string): string[] {
  return core.getSessionStore(id).store.getter(planStageCheckpointsAtom).map((point) => point.stageId)
}

/** 只数「记了一笔 planStageCheckpoints 增量账」的条目——同一次 setPlan 还会带一笔 plan 槽位的账。 */
function checkpointAppendCount(session: ReturnType<Core['getSessionStore']>): number {
  return session.history.getState().entries
    .filter((entry) => entry.ops.some((op) => op.key === 'planStageCheckpoints:append'))
    .length
}

describe('追加账本的大小', () => {
  it('追加一条的账不含已攒下的其他阶段的 plan 快照', () => {
    // 整值记账下这条必挂：before/after 各存一份完整列表，含之前每个回退点的完整 plan 快照
    // （每条快照都装着阶段开始前的全部计划状态，是这个槽位里最重的载荷）。
    function bytesAfter(existing: number): number {
      const { session } = seeded()
      for (let index = 0; index < existing; index += 1) {
        appendPlanStageCheckpointLogged(session, checkpoint(`old${index}`, 4096))
      }
      appendPlanStageCheckpointLogged(session, checkpoint('measured'))
      const { entries } = session.history.getState()
      return JSON.stringify(entries[entries.length - 1]?.ops).length
    }
    expect(bytesAfter(50)).toBe(bytesAfter(1))
    expect(bytesAfter(50)).toBeLessThan(1024)
  })
})

describe('追加的逆操作', () => {
  it('撤销弹掉的正是刚追加的那条', () => {
    const { core, id, session } = seeded()
    appendPlanStageCheckpointLogged(session, checkpoint('st1'))
    appendPlanStageCheckpointLogged(session, checkpoint('st2'))

    expect(core.undoEntry()).toEqual({ ok: true, entries: 1 })
    expect(stageIds(core, id)).toEqual(['st1'])
    expect(core.redoEntry()).toEqual({ ok: true, entries: 1 })
    expect(stageIds(core, id)).toEqual(['st1', 'st2'])
  })

  it('尾部不是自己那条时停住，不乱改别人的条目', () => {
    const { core, id, session } = seeded()
    appendPlanStageCheckpointLogged(session, checkpoint('st1'))
    // 绕开写入器直接改 store，模拟「世界与日志对不上」（外部改动 / 漏账）。
    session.store.setter(planStageCheckpointsAtom, () => [checkpoint('st1'), checkpoint('intruder')])
    const cursorBefore = session.history.getState().cursor

    // fail-closed：宁可 undo 停住，也不要把 intruder 当成 'st1' 弹掉。
    expect(core.undoEntry()).toEqual({ ok: false, refusal: 'nothing_to_apply', entries: 0 })
    expect(stageIds(core, id)).toEqual(['st1', 'intruder'])
    expect(session.history.getState().cursor).toBe(cursorBefore)
  })
})

describe('不该记账时真的不记账', () => {
  it('redo 时尾部已经是这条则停住，不重复追加出一份', () => {
    const { core, id, session } = seeded()
    appendPlanStageCheckpointLogged(session, checkpoint('st1'))
    appendPlanStageCheckpointLogged(session, checkpoint('st2'))
    core.undoEntry()
    // 世界已经和日志下一步要重放的值一致（模拟外部已经把 st2 加回来，日志游标还没跟上）。
    session.store.setter(planStageCheckpointsAtom, () => [checkpoint('st1'), checkpoint('st2')])
    const cursorBefore = session.history.getState().cursor

    expect(core.redoEntry()).toEqual({ ok: false, refusal: 'nothing_to_apply', entries: 0 })
    expect(stageIds(core, id)).toEqual(['st1', 'st2'])
    expect(session.history.getState().cursor).toBe(cursorBefore)
  })

  it('setPlan 侧同一 stageId 不会触发二次追加（上游按 id 去重）', () => {
    const { core, id, session } = seeded()
    const stagePlan = (revision: number, status: PlanStageStatus): PlanSnapshot => ({
      schemaVersion: 4,
      id: 'p1',
      title: 'plan',
      objective: 'o',
      status: 'active',
      revision,
      requiresApproval: false,
      createdAt: 1,
      updatedAt: revision,
      stages: [{
        id: 'st1', title: '阶段 1', objective: 'o', deliverables: [], dependencies: [], status, evidence: [],
      }],
    })
    setPlan(id, stagePlan(1, 'pending'), core)
    setPlan(id, stagePlan(2, 'in_progress'), core)
    const before = checkpointAppendCount(session)
    expect(before).toBe(1)

    // 阶段失败重试：再次转 in_progress，但同一 stageId 已经有回退点，recordStageCheckpoints
    // 会把它从 fresh 里过滤掉，连 append 都不会被调用——盯 append 笔数而不是总 entries 数，
    // 因为 setPlan 每次都会带一笔 plan 槽位自己的账，那笔账的增减不是本测试要挡的东西。
    setPlan(id, stagePlan(3, 'failed'), core)
    setPlan(id, stagePlan(4, 'in_progress'), core)

    expect(checkpointAppendCount(session)).toBe(before)
    expect(stageIds(core, id)).toEqual(['st1'])
  })
})
