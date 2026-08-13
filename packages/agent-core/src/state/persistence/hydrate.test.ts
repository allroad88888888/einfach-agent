// D-3 · 启动 hydrate 的单测（测试先行：红 → 绿）。
// ---------------------------------------------------------------------------
// 覆盖 §4 D-3 / DK1 / DK2 三条：
//   · 有持久化会话 → 回填 rootStore（sessionsAtom + 按 updatedAt 最新的 activeSessionId）
//     + 各会话 store（checkpointsAtom / itemsAtom=最新轮 items / currentTurnIndexAtom=最新轮），返回 true；
//   · 空 sessions → 返回 false 且 rootStore 不变（让 main.tsx 去种子）；
//   · loadSessions 抛错 → 返回 false 且不抛（容错，DK2）。
// 用内存 HistoryDriver + fake sessions（{ loadSessions }），不引真实 IndexedDB。
// 模型兼容迁移（老模型名/reasoning_effort 恢复期适配）另见 hydrate.modelMigration.test.ts（T4 拆分）。

import { describe, expect, it } from 'vitest'

import type { Checkpoint } from '../checkpoint.type'
import type { SessionMeta } from '../core.type'
import {
  rootStore,
  workspacesAtom,
  activeWorkspaceIdAtom,
  sessionsAtom,
  activeSessionIdAtom,
} from '../rootStore'
import { getSessionStore } from '../sessionStore'
import { checkpointsAtom, currentTurnIndexAtom, itemsAtom, planAtom, runAtom } from '../sessionAtoms'
import { queuedUserMessagesAtom } from '../transientAtoms'
import { createMemoryHistoryDriver } from './memoryHistoryDriver'
import { hydrate } from './hydrate'

// 两个会话：s2 的 updatedAt 更大（更新更晚），hydrate 后应作为 active。
const s1: SessionMeta = {
  id: 's1',
  title: 'A',
  settings: { vendor: 'deepseek', model: 'x' },
  createdAt: 0,
  updatedAt: 100,
}
const s2: SessionMeta = {
  id: 's2',
  title: 'B',
  settings: { vendor: 'deepseek', model: 'x' },
  createdAt: 0,
  updatedAt: 200,
}

// 造一轮 checkpoint：turnIndex + 一条 user item（内容含标记便于断言）。
function cp(turnIndex: number, content: string): Checkpoint {
  return {
    turnIndex,
    label: `t${turnIndex}`,
    createdAt: turnIndex,
    items: [{ id: `${content}-${turnIndex}`, createdAt: turnIndex, item: { role: 'user', content } }],
  }
}

describe('hydrate', () => {
  it('有持久化会话 → 回填 rootStore + 各会话 store，返回 true', async () => {
    const history = createMemoryHistoryDriver()
    // s1 两轮、s2 三轮。
    await history.saveCheckpoint('s1', cp(0, 's1a'))
    await history.saveCheckpoint('s1', cp(1, 's1b'))
    await history.saveCheckpoint('s2', cp(0, 's2a'))
    await history.saveCheckpoint('s2', cp(1, 's2b'))
    await history.saveCheckpoint('s2', cp(2, 's2c'))

    const sessions = { loadSessions: async () => [s1, s2] }
    const result = await hydrate({ sessions, history })

    expect(result).toBe(true)
    // 旧会话会被挂到迁移生成的默认工作区，不再重复携带目录字段。
    const restoredSessions = rootStore.getter(sessionsAtom)
    expect(restoredSessions.s1).toMatchObject(s1)
    expect(restoredSessions.s2).toMatchObject(s2)
    expect(restoredSessions.s1.workspaceId).toBe(restoredSessions.s2.workspaceId)
    expect(rootStore.getter(workspacesAtom)[restoredSessions.s1.workspaceId!].name).toBe('默认工作区')
    expect(rootStore.getter(activeWorkspaceIdAtom)).toBe(restoredSessions.s2.workspaceId)
    // active = updatedAt 最新（s2, 200 > 100）。
    expect(rootStore.getter(activeSessionIdAtom)).toBe('s2')

    // s1：checkpoints 恢复两轮、currentTurnIndex=1、items=最新轮 items。
    const store1 = getSessionStore('s1').store
    expect(store1.getter(checkpointsAtom)).toHaveLength(2)
    expect(store1.getter(currentTurnIndexAtom)).toBe(1)
    expect(store1.getter(itemsAtom)).toEqual(cp(1, 's1b').items)

    // s2：checkpoints 恢复三轮、currentTurnIndex=2、items=最新轮 items。
    const store2 = getSessionStore('s2').store
    expect(store2.getter(checkpointsAtom)).toHaveLength(3)
    expect(store2.getter(currentTurnIndexAtom)).toBe(2)
    expect(store2.getter(itemsAtom)).toEqual(cp(2, 's2c').items)
  })

  it('重启 hydrate 保留会话级 loadedTools，供新 run 重建当前 schema', async () => {
    const history = createMemoryHistoryDriver()
    const persisted: SessionMeta = {
      ...s1,
      loadedTools: ['shell_macos', 'read_file'],
    }

    await expect(hydrate({
      sessions: { loadSessions: async () => [persisted] },
      history,
    })).resolves.toBe(true)

    expect(rootStore.getter(sessionsAtom).s1?.loadedTools)
      .toEqual(['shell_macos', 'read_file'])
  })

  it('重启时从 SessionMeta 恢复计划及各步骤的最终状态', async () => {
    const history = createMemoryHistoryDriver()
    const persisted: SessionMeta = {
      ...s1,
      plan: {
        schemaVersion: 4,
        id: 'plan-persisted',
        title: '持久化计划',
        objective: '验证桌面重启恢复',
        status: 'active',
        revision: 6,
        requiresApproval: false,
        createdAt: 1,
        updatedAt: 2,
        stages: [
          {
            id: 'design',
            title: '设计',
            objective: '完成设计',
            deliverables: [],
            dependencies: [],
            status: 'completed',
            evidence: ['设计已验收'],
          },
          {
            id: 'implement',
            title: '实现',
            objective: '完成实现',
            deliverables: [],
            dependencies: ['design'],
            status: 'in_progress',
            evidence: [],
          },
        ],
      },
    }

    await expect(hydrate({
      sessions: { loadSessions: async () => [persisted] },
      history,
    })).resolves.toBe(true)

    expect(getSessionStore('s1').store.getter(planAtom)).toMatchObject({
      id: 'plan-persisted',
      revision: 6,
      status: 'active',
      stages: [
        { id: 'design', status: 'completed' },
        { id: 'implement', status: 'in_progress' },
      ],
    })
  })

  it('最新工作 checkpoint 的 running 恢复为 interrupted，并保留 run 锚点与排队输入', async () => {
    const history = createMemoryHistoryDriver()
    const working: Checkpoint = {
      ...cp(0, '进行中的普通任务'),
      label: '[执行中] 进行中的普通任务',
      recovery: {
        run: {
          runId: 'run-before-restart',
          turnId: '进行中的普通任务-0',
          status: 'running',
          pendingExecutionId: 'stale-execution',
          loadedTools: ['write_file'],
        },
        queuedUserMessages: [{
          id: 'q1',
          createdAt: 2,
          content: '补充要求',
          targetRunId: 'run-before-restart',
        }],
      },
    }
    await history.saveCheckpoint('s1', working)

    await expect(hydrate({
      sessions: { loadSessions: async () => [s1] },
      history,
    })).resolves.toBe(true)

    const store = getSessionStore('s1').store
    expect(store.getter(runAtom)).toEqual({
      runId: 'run-before-restart',
      turnId: '进行中的普通任务-0',
      status: 'interrupted',
      pendingExecutionId: undefined,
      loadedTools: ['write_file'],
    })
    expect(store.getter(queuedUserMessagesAtom)).toEqual(working.recovery?.queuedUserMessages)
  })

  it('等待用户的 checkpoint 原样恢复 pending 决策，不误标为 interrupted', async () => {
    const history = createMemoryHistoryDriver()
    const pendingQuestion = { questions: [{ id: 'choice', question: '继续吗？' }] }
    await history.saveCheckpoint('s1', {
      ...cp(0, '等待回答'),
      recovery: {
        run: {
          runId: 'waiting-run',
          turnId: '等待回答-0',
          status: 'waiting_user',
          pendingQuestion,
        },
      },
    })

    await hydrate({ sessions: { loadSessions: async () => [s1] }, history })

    expect(getSessionStore('s1').store.getter(runAtom)).toMatchObject({
      runId: 'waiting-run',
      status: 'waiting_user',
      pendingQuestion,
    })
  })

  it('空 sessions → 返回 false 且 rootStore 不变', async () => {
    const history = createMemoryHistoryDriver()
    const sessions = { loadSessions: async () => [] as SessionMeta[] }

    const result = await hydrate({ sessions, history })

    expect(result).toBe(false)
    expect(rootStore.getter(sessionsAtom)).toEqual({})
    expect(rootStore.getter(activeSessionIdAtom)).toBe('')
  })

  it('loadSessions 抛错 → 返回 false 且不抛', async () => {
    const history = createMemoryHistoryDriver()
    const sessions = {
      loadSessions: async (): Promise<SessionMeta[]> => {
        throw new Error('boom')
      },
    }

    // resolves.toBe(false) 同时断言「不抛」+「返回 false」。
    await expect(hydrate({ sessions, history })).resolves.toBe(false)
    expect(rootStore.getter(sessionsAtom)).toEqual({})
  })
})
