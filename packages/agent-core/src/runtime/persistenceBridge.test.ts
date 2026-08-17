// D-4 · 持久化接线桥的单测（测试先行：红 → 绿）。
// ---------------------------------------------------------------------------
// 覆盖两条：
//   · 已配置（注入 mock history / sessions）→ 各 persist* 转成对应 driver 调用，且不抛；
//     driver 内部 reject 时 `.catch` 吞掉、仍不抛（DK2 fire-and-forget）。
//   · 未配置（undefined）→ 各 persist* 全部 no-op、不抛。
// 用 vi.fn 的假 driver，不引真实 IndexedDB。

import { afterEach, describe, expect, it, vi } from 'vitest'

import { rootStore, sessionsAtom, workspacesAtom } from '../state/rootStore'
import type { SessionMeta, WorkspaceMeta } from '../state/core.type'
import type { SessionsPersistence } from '../state/persistence/contract'
import {
  configurePersistence,
  hydratePersistence,
  resetPersistence,
  persistSessions,
  persistWorkspaces,
} from './persistenceBridge'

afterEach(() => {
  resetPersistence()
  vi.clearAllMocks()
})

// 假会话列表存储（默认 resolve）。
function mockSessions(overrides?: Partial<SessionsPersistence>): SessionsPersistence {
  return {
    saveSessions: vi.fn(async (_: SessionMeta[]) => {}),
    loadSessions: vi.fn(async () => [] as SessionMeta[]),
    saveWorkspaces: vi.fn(async (_: WorkspaceMeta[]) => {}),
    loadWorkspaces: vi.fn(async () => [] as WorkspaceMeta[]),
    ...overrides,
  }
}

const meta: SessionMeta = {
  id: 's1',
  title: 't',
  settings: { vendor: 'deepseek', model: 'x' },
  createdAt: 0,
  updatedAt: 0,
}

describe('persistenceBridge（D-4 fire-and-forget 接线）', () => {
  it('persistSessions：把 rootStore.sessionsAtom 全部 SessionMeta 交给 saveSessions', () => {
    const sessions = mockSessions()
    configurePersistence({ sessions })
    rootStore.setter(sessionsAtom, { s1: meta })

    expect(() => persistSessions()).not.toThrow()
    expect(sessions.saveSessions).toHaveBeenCalledWith([meta])
  })

  it('persistSessions：静态投影会阻止未知运行时字段再次写回 session 元数据', () => {
    const sessions = mockSessions()
    configurePersistence({ sessions })
    const rawMeta = {
      ...meta,
      obsoleteRuntimeState: { id: 'torn-state', status: 'active' },
    } as unknown as SessionMeta
    rootStore.setter(sessionsAtom, { s1: rawMeta })

    persistSessions()

    const saved = vi.mocked(sessions.saveSessions).mock.calls[0]?.[0]
    expect(saved).toEqual([meta])
    expect(saved?.[0]).not.toHaveProperty('obsoleteRuntimeState')
  })

  it('persistSessions：把 plan 操作关联 ID 传给支持诊断的 driver', () => {
    const sessions = mockSessions()
    configurePersistence({ sessions })
    rootStore.setter(sessionsAtom, { s1: meta })

    persistSessions({ operationId: 'plan-op-1', reason: 'plan.update', sessionId: 's1' })

    expect(sessions.saveSessions).toHaveBeenCalledWith([meta], 'plan-op-1')
  })

  it('persistWorkspaces：把 rootStore.workspacesAtom 全部 WorkspaceMeta 交给 saveWorkspaces', () => {
    const sessions = mockSessions()
    const workspace: WorkspaceMeta = { id: 'w1', name: 'Workspace', createdAt: 0, updatedAt: 0 }
    configurePersistence({ sessions })
    rootStore.setter(workspacesAtom, { w1: workspace })

    expect(() => persistWorkspaces()).not.toThrow()
    expect(sessions.saveWorkspaces).toHaveBeenCalledWith([workspace])
  })

  it('persistSessions：写入繁忙时只补写最新快照，不排队保存每个中间状态', async () => {
    let releaseFirst: (() => void) | undefined
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const saveSessions = vi.fn()
      .mockImplementationOnce(() => firstWrite)
      .mockResolvedValue(undefined)
    const sessions = mockSessions({ saveSessions })
    configurePersistence({ sessions })

    rootStore.setter(sessionsAtom, { s1: meta })
    persistSessions({ operationId: 'initial' })
    rootStore.setter(sessionsAtom, { s1: { ...meta, updatedAt: 1 } })
    persistSessions({ operationId: 'intermediate' })
    rootStore.setter(sessionsAtom, { s1: { ...meta, updatedAt: 2 } })
    persistSessions({ operationId: 'latest' })

    expect(saveSessions).toHaveBeenCalledTimes(1)
    expect(saveSessions).toHaveBeenNthCalledWith(1, [meta], 'initial')

    releaseFirst?.()
    await firstWrite
    await Promise.resolve()
    await Promise.resolve()

    expect(saveSessions).toHaveBeenCalledTimes(2)
    expect(saveSessions).toHaveBeenNthCalledWith(
      2,
      [{ ...meta, updatedAt: 2 }],
      'latest',
    )
  })

  it('driver reject → .catch 吞掉，persist* 不抛（DK2）', async () => {
    const sessions = mockSessions({ saveSessions: vi.fn(async () => { throw new Error('boom') }) })
    configurePersistence({ sessions })
    rootStore.setter(sessionsAtom, { s1: meta })

    expect(() => persistSessions()).not.toThrow()
    // 让被 .catch 挂住的微任务跑完，确认没有 unhandled rejection 逃逸。
    await Promise.resolve()
    await Promise.resolve()
  })

  it('未配置（undefined）→ 各 persist* 全部 no-op、不抛', () => {
    // afterEach 已 resetPersistence，本用例进入时 sessions 为 undefined。
    rootStore.setter(sessionsAtom, { s1: meta })
    expect(() => persistSessions()).not.toThrow()
    expect(() => persistWorkspaces()).not.toThrow()
  })
})

// 启动读回（盘点 E4）：宿主不再自己深挖 state/persistence/hydrate 并手拼 driver，
// 读回用的就是 configurePersistence 注入的那对实例。
describe('hydratePersistence（启动读回收口）', () => {
  it('未配置 driver → 直接 false，不去读盘', async () => {
    await expect(hydratePersistence()).resolves.toBe(false)
  })

  it('用 configurePersistence 注入的那对 driver 读回；盘上无会话 → false', async () => {
    const sessions = mockSessions()
    configurePersistence({ sessions })

    await expect(hydratePersistence()).resolves.toBe(false)
    expect(sessions.loadSessions).toHaveBeenCalled()
  })

  it('盘上有会话 → 回填 rootStore 并返回 true', async () => {
    const sessions = mockSessions({ loadSessions: vi.fn(async () => [meta]) })
    configurePersistence({ sessions })

    await expect(hydratePersistence()).resolves.toBe(true)
    expect(rootStore.getter(sessionsAtom).s1?.id).toBe('s1')
  })
})
