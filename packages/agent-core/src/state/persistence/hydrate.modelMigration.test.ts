// 从 hydrate.test.ts 拆出（T4）：下线模型名迁移（modelMigration）—— 恢复路径上的兼容层。
// settings.model 是持久化字段：老会话恢复出来时仍是当初存下的模型名。DeepSeek 官方公告
// deepseek-chat / deepseek-reasoner 于 2026/07/24 15:59 UTC 下线，存量会话届时一发请求就是 400，
// 故 hydrate 在写进 sessionsAtom 之前必须先兼容旧名；仍可用的用户模型选择不得改写。
// 主 hydrate 行为（回填 rootStore/各会话 store、空 sessions、loadSessions 抛错）见 hydrate.test.ts。

import { describe, expect, it } from 'vitest'

import type { Checkpoint } from '../checkpoint.type'
import type { ModelSettings, SessionMeta } from '../core.type'
import {
  rootStore,
  sessionsAtom,
  activeSessionIdAtom,
  resetRootStore,
} from '../rootStore'
import { getSessionStore, resetSessionStores } from '../sessionStore'
import { checkpointsAtom, itemsAtom } from '../sessionAtoms'
import { createMemoryHistoryDriver } from './memoryHistoryDriver'
import { hydrate } from './hydrate'

// 造一轮 checkpoint：turnIndex + 一条 user item（内容含标记便于断言）。
function cp(turnIndex: number, content: string): Checkpoint {
  return {
    turnIndex,
    label: `t${turnIndex}`,
    createdAt: turnIndex,
    items: [{ id: `${content}-${turnIndex}`, createdAt: turnIndex, item: { role: 'user', content } }],
  }
}

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

describe('hydrate · 主 Agent 模型兼容迁移', () => {
  it('存量 deepseek-chat 会话 → 恢复后是 Flash + 非思考模式', async () => {
    const history = createMemoryHistoryDriver()
    const sessions = { loadSessions: async () => [legacySession('old', 'deepseek-chat')] }

    await hydrate({ sessions, history })

    const restored = rootStore.getter(sessionsAtom).old
    expect(restored.settings.model).toBe('deepseek-v4-flash')
    expect(restored.settings.thinking).toBe(false)
  })

  it('存量 deepseek-reasoner 会话 → 恢复后是 Flash + 思考模式', async () => {
    const history = createMemoryHistoryDriver()
    const sessions = { loadSessions: async () => [legacySession('old', 'deepseek-reasoner')] }

    await hydrate({ sessions, history })

    const restored = rootStore.getter(sessionsAtom).old
    expect(restored.settings.model).toBe('deepseek-v4-flash')
    expect(restored.settings.thinking).toBe(true)
  })

  it('用户已显式设置的 thinking 不被迁移覆盖', async () => {
    const history = createMemoryHistoryDriver()
    // 显式关了思考的 deepseek-reasoner 会话：模型名要迁，thinking=false 是用户的选择，得留着。
    const sessions = { loadSessions: async () => [legacySession('old', 'deepseek-reasoner', false)] }

    await hydrate({ sessions, history })

    const restored = rootStore.getter(sessionsAtom).old
    expect(restored.settings.model).toBe('deepseek-v4-flash')
    expect(restored.settings.thinking).toBe(false)
  })

  it('已是 Flash、Pro 或未知模型名的会话原样保留', async () => {
    const history = createMemoryHistoryDriver()
    const flash = legacySession('flash', 'deepseek-v4-flash')
    const fresh = legacySession('fresh', 'deepseek-v4-pro')
    const custom = legacySession('custom', 'my-private-finetune')
    const sessions = { loadSessions: async () => [flash, fresh, custom] }

    await hydrate({ sessions, history })

    const restored = rootStore.getter(sessionsAtom)
    expect(restored.flash).toMatchObject(flash)
    expect(restored.fresh).toMatchObject(fresh)
    expect(restored.custom).toMatchObject(custom)
    expect(restored.fresh.workspaceId).toBe(restored.custom.workspaceId)
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

    const restored = rootStore.getter(sessionsAtom)['legacy-effort'].settings
    // 老数据把 reasoning_effort 平铺在顶层，读回后应收进供应商附加设置袋。
    expect(restored).not.toHaveProperty('reasoning_effort')
    expect(restored.vendorSettings?.reasoning_effort).toBe(after)
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
      } as unknown as ModelSettings,
    }
    const sessions = { loadSessions: async () => [invalidDeepSeek, glm] }

    await hydrate({ sessions, history })

    const restored = rootStore.getter(sessionsAtom)
    expect(restored['invalid-effort'].settings).not.toHaveProperty('reasoning_effort')
    expect(restored['invalid-effort'].settings.vendorSettings?.reasoning_effort).toBeUndefined()
    // 未被归一化的厂商：设置袋原样保留老值，不因为 core 不认识它就丢掉。
    expect(restored['glm-effort'].settings.vendorSettings?.reasoning_effort).toBe('low')
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

    // 内存里已兼容为 Flash，行为不受影响。
    expect(rootStore.getter(sessionsAtom).old.settings.model).toBe('deepseek-v4-flash')
    // R10: 无 v1 恢复快照的存量 checkpoint 仅作为撤销历史保留，绝不投影为可继续的动态态。
    const sessionStore = getSessionStore('old').store
    expect(sessionStore.getter(itemsAtom)).toEqual([])
    expect(sessionStore.getter(checkpointsAtom)).toEqual([cp(0, 'hello')])
  })

  it('只读 deps（没有 saveSessions）也能正常迁移，不抛', async () => {
    const history = createMemoryHistoryDriver()
    const sessions = { loadSessions: async () => [legacySession('old', 'deepseek-chat')] }

    await expect(hydrate({ sessions, history })).resolves.toBe(true)
    expect(rootStore.getter(sessionsAtom).old.settings.model).toBe('deepseek-v4-flash')
  })

  it('重启幂等：盘上仍是旧名，第二次启动照样迁得对（这正是不回写的前提）', async () => {
    const history = createMemoryHistoryDriver()
    // 盘上数据【始终】是旧名——模拟「不回写」之后的真实盘面。
    const sessions = { loadSessions: async () => [legacySession('old', 'deepseek-chat')] }

    await hydrate({ sessions, history })
    expect(rootStore.getter(sessionsAtom).old.settings.model).toBe('deepseek-v4-flash')

    await hydrate({ sessions, history })
    expect(rootStore.getter(sessionsAtom).old.settings.model).toBe('deepseek-v4-flash')
    expect(rootStore.getter(sessionsAtom).old.settings.thinking).toBe(false)
  })
})
