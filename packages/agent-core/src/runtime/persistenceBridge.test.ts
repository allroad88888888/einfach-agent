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
import type { Checkpoint } from '../state/checkpoint.type'
import type { SessionsPersistence } from '../state/persistence/contract'
import type { HistoryDriver } from '../state/persistence/historyDriver'
import {
  configurePersistence,
  resetPersistence,
  persistSessions,
  persistWorkspaces,
  persistCheckpoint,
  persistTruncate,
  persistDeleteSession,
} from './persistenceBridge'

afterEach(() => {
  resetPersistence()
  vi.clearAllMocks()
})

// 全 vi.fn 的假 HistoryDriver（默认 resolve）；可选 overrides 注入 reject 分支。
function mockHistory(overrides?: Partial<HistoryDriver>): HistoryDriver {
  return {
    listCheckpoints: vi.fn(async () => []),
    loadCheckpoint: vi.fn(async () => undefined),
    saveCheckpoint: vi.fn(async () => {}),
    truncateAfter: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
    ...overrides,
  }
}

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

const cp: Checkpoint = {
  turnIndex: 0,
  label: 'l',
  createdAt: 0,
  items: [{ id: 'i', createdAt: 0, item: { role: 'user', content: 'hi' } }],
}

describe('persistenceBridge（D-4 fire-and-forget 接线）', () => {
  it('persistSessions：把 rootStore.sessionsAtom 全部 SessionMeta 交给 saveSessions', () => {
    const sessions = mockSessions()
    configurePersistence({ sessions })
    rootStore.setter(sessionsAtom, { s1: meta })

    expect(() => persistSessions()).not.toThrow()
    expect(sessions.saveSessions).toHaveBeenCalledWith([meta])
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

  it('persistCheckpoint：转成 history.saveCheckpoint(id, cp)', () => {
    const history = mockHistory()
    configurePersistence({ history })

    expect(() => persistCheckpoint('s1', cp)).not.toThrow()
    expect(history.saveCheckpoint).toHaveBeenCalledWith('s1', cp)
  })

  it('persistCheckpoint：同一会话的工作快照与最终快照严格按调用顺序写入', async () => {
    let releaseFirst: (() => void) | undefined
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const saveCheckpoint = vi.fn()
      .mockImplementationOnce(() => firstWrite)
      .mockResolvedValue(undefined)
    const history = mockHistory({ saveCheckpoint })
    configurePersistence({ history })
    const finalCheckpoint = { ...cp, label: 'done' }

    persistCheckpoint('s1', cp)
    persistCheckpoint('s1', finalCheckpoint)

    expect(saveCheckpoint).toHaveBeenCalledTimes(1)
    expect(saveCheckpoint).toHaveBeenNthCalledWith(1, 's1', cp)

    releaseFirst?.()
    await firstWrite
    await Promise.resolve()

    expect(saveCheckpoint).toHaveBeenCalledTimes(2)
    expect(saveCheckpoint).toHaveBeenNthCalledWith(2, 's1', finalCheckpoint)
  })

  it('persistTruncate：等待同会话排队 checkpoint 写入完成后再截断', async () => {
    let releaseFirst: (() => void) | undefined
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const calls: string[] = []
    const saveCheckpoint = vi.fn()
      .mockImplementationOnce(() => {
        calls.push('checkpoint:working')
        return firstWrite
      })
      .mockImplementation(() => {
        calls.push('checkpoint:final')
        return Promise.resolve()
      })
    const truncateAfter = vi.fn(async () => {
      calls.push('truncate')
    })
    configurePersistence({ history: mockHistory({ saveCheckpoint, truncateAfter }) })

    persistCheckpoint('s1', cp)
    persistCheckpoint('s1', { ...cp, label: 'done' })
    persistTruncate('s1', 0)

    expect(calls).toEqual(['checkpoint:working'])
    releaseFirst?.()
    await firstWrite
    for (let index = 0; index < 5; index += 1) await Promise.resolve()

    expect(calls).toEqual(['checkpoint:working', 'checkpoint:final', 'truncate'])
    expect(truncateAfter).toHaveBeenCalledWith('s1', 0)
  })

  it('persistTruncate：转成 history.truncateAfter(id, turnIndex)', () => {
    const history = mockHistory()
    configurePersistence({ history })

    expect(() => persistTruncate('s1', 2)).not.toThrow()
    expect(history.truncateAfter).toHaveBeenCalledWith('s1', 2)
  })

  it('persistDeleteSession：转成 history.deleteSession(id)', () => {
    const history = mockHistory()
    configurePersistence({ history })

    expect(() => persistDeleteSession('s1')).not.toThrow()
    expect(history.deleteSession).toHaveBeenCalledWith('s1')
  })

  it('configurePersistence：浅合并，只覆盖传入字段（分两次注入 history / sessions）', () => {
    const history = mockHistory()
    const sessions = mockSessions()
    configurePersistence({ history })
    configurePersistence({ sessions }) // 不应清掉上一次注入的 history
    rootStore.setter(sessionsAtom, { s1: meta })

    persistCheckpoint('s1', cp)
    persistSessions()
    expect(history.saveCheckpoint).toHaveBeenCalledWith('s1', cp)
    expect(sessions.saveSessions).toHaveBeenCalledWith([meta])
  })

  it('driver reject → .catch 吞掉，persist* 不抛（DK2）', async () => {
    const history = mockHistory({ saveCheckpoint: vi.fn(async () => { throw new Error('boom') }) })
    const sessions = mockSessions({ saveSessions: vi.fn(async () => { throw new Error('boom') }) })
    configurePersistence({ history, sessions })
    rootStore.setter(sessionsAtom, { s1: meta })

    expect(() => persistCheckpoint('s1', cp)).not.toThrow()
    expect(() => persistSessions()).not.toThrow()
    // 让被 .catch 挂住的微任务跑完，确认没有 unhandled rejection 逃逸。
    await Promise.resolve()
    await Promise.resolve()
  })

  it('未配置（undefined）→ 各 persist* 全部 no-op、不抛', () => {
    // afterEach 已 resetPersistence，本用例进入时 history/sessions 均为 undefined。
    rootStore.setter(sessionsAtom, { s1: meta })
    expect(() => persistSessions()).not.toThrow()
    expect(() => persistCheckpoint('s1', cp)).not.toThrow()
    expect(() => persistTruncate('s1', 1)).not.toThrow()
    expect(() => persistDeleteSession('s1')).not.toThrow()
  })
})
