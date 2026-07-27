// D-3 · 启动 hydrate 的单测（测试先行：红 → 绿）。
// ---------------------------------------------------------------------------
// 覆盖 §4 D-3 / DK1 / DK2 三条：
//   · 有持久化会话 → 回填 rootStore（sessionsAtom + 按 updatedAt 最新的 activeSessionId）
//     + 各会话 store（checkpointsAtom / itemsAtom=最新轮 items / currentTurnIndexAtom=最新轮），返回 true；
//   · 空 sessions → 返回 false 且 rootStore 不变（让 main.tsx 去种子）；
//   · loadSessions 抛错 → 返回 false 且不抛（容错，DK2）。
// 用内存 HistoryDriver + fake sessions（{ loadSessions }），不引真实 IndexedDB。

import { afterEach, describe, expect, it } from 'vitest'

import type { Checkpoint } from '../checkpoint.type'
import type { ModelSettings, SessionMeta } from '../core.type'
import {
  rootStore,
  workspacesAtom,
  activeWorkspaceIdAtom,
  sessionsAtom,
  activeSessionIdAtom,
  resetRootStore,
} from '../rootStore'
import { getSessionStore, resetSessionStores } from '../sessionStore'
import { checkpointsAtom, currentTurnIndexAtom, itemsAtom, planAtom, runAtom } from '../sessionAtoms'
import { queuedUserMessagesAtom } from '../transientAtoms'
import { createMemoryHistoryDriver } from './memoryHistoryDriver'
import { hydrate } from './hydrate'

afterEach(() => {
  resetRootStore()
  resetSessionStores()
})

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
        schemaVersion: 2,
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
            acceptanceCriteria: ['设计完成'],
            dependencies: [],
            status: 'completed',
            evidence: ['设计已验收'],
          },
          {
            id: 'implement',
            title: '实现',
            objective: '完成实现',
            deliverables: [],
            acceptanceCriteria: ['实现完成'],
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

// ===========================================================================
// 下线模型名迁移（modelMigration）—— 恢复路径上的兼容层
// ---------------------------------------------------------------------------
// settings.model 是持久化字段：老会话恢复出来时仍是当初存下的模型名。DeepSeek 官方公告
// deepseek-chat / deepseek-reasoner 于 2026/07/24 15:59 UTC 下线，存量会话届时一发请求就是 400，
// 故 hydrate 在写进 sessionsAtom 之前必须先兼容旧名，再把主 Agent 标准模型收口到 Pro。
// ===========================================================================

// 造一个只指定模型名（及可选 thinking）的存量会话。
function legacySession(id: string, model: string, thinking?: boolean): SessionMeta {
  return {
    id,
    title: id,
    settings: { vendor: 'deepseek', model, ...(thinking === undefined ? {} : { thinking }) },
    createdAt: 0,
    updatedAt: 100,
  }
}

function legacyReasoningSession(id: string, reasoningEffort: unknown): SessionMeta {
  return {
    ...legacySession(id, 'deepseek-v4-pro'),
    settings: {
      vendor: 'deepseek',
      model: 'deepseek-v4-pro',
      reasoning_effort: reasoningEffort,
    } as unknown as ModelSettings,
  }
}

describe('hydrate · 主 Agent 模型归一化', () => {
  it('存量 deepseek-chat 会话 → 恢复后是 Pro + 非思考模式', async () => {
    const history = createMemoryHistoryDriver()
    const sessions = { loadSessions: async () => [legacySession('old', 'deepseek-chat')] }

    await hydrate({ sessions, history })

    const restored = rootStore.getter(sessionsAtom).old
    expect(restored.settings.model).toBe('deepseek-v4-pro')
    expect(restored.settings.thinking).toBe(false)
  })

  it('存量 deepseek-reasoner 会话 → 恢复后是 Pro + 思考模式', async () => {
    const history = createMemoryHistoryDriver()
    const sessions = { loadSessions: async () => [legacySession('old', 'deepseek-reasoner')] }

    await hydrate({ sessions, history })

    const restored = rootStore.getter(sessionsAtom).old
    expect(restored.settings.model).toBe('deepseek-v4-pro')
    expect(restored.settings.thinking).toBe(true)
  })

  it('用户已显式设置的 thinking 不被迁移覆盖', async () => {
    const history = createMemoryHistoryDriver()
    // 显式关了思考的 deepseek-reasoner 会话：模型名要迁，thinking=false 是用户的选择，得留着。
    const sessions = { loadSessions: async () => [legacySession('old', 'deepseek-reasoner', false)] }

    await hydrate({ sessions, history })

    const restored = rootStore.getter(sessionsAtom).old
    expect(restored.settings.model).toBe('deepseek-v4-pro')
    expect(restored.settings.thinking).toBe(false)
  })

  it('已是新模型名 / 未知模型名的会话原样保留', async () => {
    const history = createMemoryHistoryDriver()
    const fresh = legacySession('fresh', 'deepseek-v4-pro')
    const custom = legacySession('custom', 'my-private-finetune')
    const sessions = { loadSessions: async () => [fresh, custom] }

    await hydrate({ sessions, history })

    const restored = rootStore.getter(sessionsAtom)
    expect(restored.fresh).toMatchObject(fresh)
    expect(restored.custom).toMatchObject(custom)
    expect(restored.fresh.workspaceId).toBe(restored.custom.workspaceId)
  })

  it('历史 Flash 主会话恢复后收口到 Pro', async () => {
    const history = createMemoryHistoryDriver()
    const sessions = { loadSessions: async () => [legacySession('flash', 'deepseek-v4-flash')] }

    await hydrate({ sessions, history })

    expect(rootStore.getter(sessionsAtom).flash.settings.model).toBe('deepseek-v4-pro')
  })

  it.each([
    ['low', 'high'],
    ['medium', 'high'],
    ['xhigh', 'max'],
  ])('历史 DeepSeek reasoning_effort=%s → 恢复后为 %s', async (before, after) => {
    const history = createMemoryHistoryDriver()
    const sessions = {
      loadSessions: async () => [legacyReasoningSession('legacy-effort', before)],
    }

    await hydrate({ sessions, history })

    expect(
      rootStore.getter(sessionsAtom)['legacy-effort'].settings.reasoning_effort,
    ).toBe(after)
  })

  it('未知持久化 reasoning_effort 不透传：DeepSeek 删除非法值，GLM 合法 low 保留', async () => {
    const history = createMemoryHistoryDriver()
    const invalidDeepSeek = legacyReasoningSession('invalid-effort', { unexpected: true })
    const glm: SessionMeta = {
      ...legacySession('glm-effort', 'glm-5'),
      settings: {
        vendor: 'glm',
        model: 'glm-5',
        reasoning_effort: 'low',
      },
    }
    const sessions = { loadSessions: async () => [invalidDeepSeek, glm] }

    await hydrate({ sessions, history })

    const restored = rootStore.getter(sessionsAtom)
    expect(restored['invalid-effort'].settings).not.toHaveProperty('reasoning_effort')
    expect(restored['glm-effort'].settings.reasoning_effort).toBe('low')
  })

  it('迁移幂等：把迁移后的结果再 hydrate 一次，结果不变', async () => {
    const history = createMemoryHistoryDriver()
    const first = { loadSessions: async () => [legacySession('old', 'deepseek-chat')] }
    await hydrate({ sessions: first, history })
    const once = rootStore.getter(sessionsAtom).old

    resetRootStore()
    resetSessionStores()

    // 第二次启动读到的就是上次迁移后的会话。
    const second = { loadSessions: async () => [once] }
    await hydrate({ sessions: second, history })

    expect(rootStore.getter(sessionsAtom).old).toEqual(once)
  })

  it('迁移不改 updatedAt —— active 会话的选取不被兼容迁移带偏', async () => {
    const history = createMemoryHistoryDriver()
    // 老会话用旧模型名但 updatedAt 更小；迁移若顶掉 updatedAt 就会把 active 抢过去。
    const old = legacySession('old', 'deepseek-chat')
    const recent = { ...legacySession('recent', 'deepseek-v4-pro'), updatedAt: 999 }
    const sessions = { loadSessions: async () => [old, recent] }

    await hydrate({ sessions, history })

    expect(rootStore.getter(sessionsAtom).old.updatedAt).toBe(100)
    expect(rootStore.getter(activeSessionIdAtom)).toBe('recent')
  })

  // ★ 迁移只改内存，【绝不回写盘】★ —— 别看到这条就以为是漏了回写又给加回来，是刻意的：
  //   1) loadSessions 的唯一调用点就是 hydrate（已全仓确认），没有绕过它直接读盘的路径，
  //      所以盘上留旧名不影响行为——每次启动重迁一遍，迁移幂等。
  //   2) 盘上保留原始值有价值：映射表是照 provider 公告手写的，万一填错或继任者变了，
  //      原始值还在就能重迁；就地覆盖会让用户当初选的模型名永久丢失。
  //   3) 回写只能是 fire-and-forget（hydrate 契约是「失败不阻塞启动」），而 saveSessions 是
  //      覆盖式落盘，与 persistenceBridge.persistSessions() 之间无顺序保证：若它晚于
  //      「用户新建会话」落地，就会用不含新会话的旧列表把那个新会话整体覆盖掉。
  it('迁移不回写盘：hydrate 全程只读，deps 里连 saveSessions 都不需要', async () => {
    const history = createMemoryHistoryDriver()
    await history.saveCheckpoint('old', cp(0, 'hello'))
    // 故意挂一个「一旦被调用就让测试失败」的 saveSessions —— 它不在 hydrate 的 deps 类型里，
    // 但运行时若有人偷偷调了它，这里会立刻炸出来。
    const sessions = {
      loadSessions: async () => [legacySession('old', 'deepseek-chat')],
      saveSessions: async (): Promise<void> => {
        throw new Error('hydrate 不应该回写盘：迁移是读时适配，不是写时改数据')
      },
    }

    await expect(hydrate({ sessions, history })).resolves.toBe(true)
    // 让出微任务：即便有人用 fire-and-forget 偷写，也能在这之后暴露出来。
    await Promise.resolve()

    // 内存里已归一化为主 Agent Pro，行为不受影响。
    expect(rootStore.getter(sessionsAtom).old.settings.model).toBe('deepseek-v4-pro')
    // 后续 checkpoint 回填照常。
    expect(getSessionStore('old').store.getter(itemsAtom)).toEqual(cp(0, 'hello').items)
  })

  it('只读 deps（没有 saveSessions）也能正常迁移，不抛', async () => {
    const history = createMemoryHistoryDriver()
    const sessions = { loadSessions: async () => [legacySession('old', 'deepseek-chat')] }

    await expect(hydrate({ sessions, history })).resolves.toBe(true)
    expect(rootStore.getter(sessionsAtom).old.settings.model).toBe('deepseek-v4-pro')
  })

  it('重启幂等：盘上仍是旧名，第二次启动照样迁得对（这正是不回写的前提）', async () => {
    const history = createMemoryHistoryDriver()
    // 盘上数据【始终】是旧名——模拟「不回写」之后的真实盘面。
    const sessions = { loadSessions: async () => [legacySession('old', 'deepseek-chat')] }

    await hydrate({ sessions, history })
    expect(rootStore.getter(sessionsAtom).old.settings.model).toBe('deepseek-v4-pro')

    await hydrate({ sessions, history })
    expect(rootStore.getter(sessionsAtom).old.settings.model).toBe('deepseek-v4-pro')
    expect(rootStore.getter(sessionsAtom).old.settings.thinking).toBe(false)
  })
})
