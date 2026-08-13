// P-R3 命令 API 的单测（红→绿）。T3 从 commands.test.ts 拆出：config 通电 + 多 core 实例隔离。
// ---------------------------------------------------------------------------
// 契约 U1/U2：commands 是 UI ↔ runtime 的唯一边界，且不收 store。
// 本测断言【实例化】口径：configureCommands 就地改写 defaultCore.config；createCoreInstance
// 的 config/store 与 defaultCore 隔离；createCommands(iso) 绑定的命令只碰 iso 自己的
// store/abort/config，不串到 defaultCore。真实 model / abort / checkpoint 全部 mock 掉。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// —— mock runtime 依赖：只验证编排，不跑真实 model / abort / checkpoint。——
vi.mock('./modelRun', () => ({
  runSession: vi.fn(() => Promise.resolve()),
  persistCurrentRunRecovery: vi.fn(),
  resumeInterruptedSession: vi.fn(() => Promise.resolve()),
  resumePlanSession: vi.fn(() => Promise.resolve()),
  runToolLoop: vi.fn(() => Promise.resolve()),
}))
vi.mock('../state/checkpointWriters', () => ({
  jumpToCheckpoint: vi.fn(),
  rewindBeforeCheckpoint: vi.fn(),
  revertToPlanStageCheckpoint: vi.fn(),
  updateCheckpoint: vi.fn(),
}))
// D-4：持久化桥全 mock —— 只验证 commands 按约定调用了落盘钩子（不跑真实 IndexedDB）。
vi.mock('./persistenceBridge', () => ({
  persistSessions: vi.fn(),
  persistWorkspaces: vi.fn(),
  persistDeleteSession: vi.fn(),
  persistTruncate: vi.fn(),
  persistCheckpoint: vi.fn(),
}))

import { rootStore, sessionsAtom, activeSessionIdAtom } from '../state/rootStore'
import { getSessionStore } from '../state/sessionStore'
import { itemsAtom } from '../state/sessionAtoms'
import type { SessionMeta } from '../state/core.type'
import { appendItem } from '../state/sessionWriters'
import { runSession } from './modelRun'
import { defaultCore, createCoreInstance } from './core/coreInstance'
import { configureCommands, createCommands, newSession, sendMessage } from './commands'
import { spyOnDefaultAbort, type AbortSpies } from './commands.testHarness'

let beginRun: AbortSpies['beginRun']

beforeEach(() => {
  ;({ beginRun } = spyOnDefaultAbort())
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('config 通电 + core 穿线（第 2/3 期实例化）', () => {
  it('configureCommands 就地写进 defaultCore.config（config 通电 = CoreInstance 第五个视图）', () => {
    configureCommands({ modelCredentials: { deepseek: 'dk-power', glm: 'gk-power' } })
    expect(defaultCore.config.modelCredentials.deepseek).toBe('dk-power')
    expect(defaultCore.config.modelCredentials.glm).toBe('gk-power')
  })

  it('configureCommands 就地改字段、不替换 config 引用（别处持有同一引用不漂移）', () => {
    const ref = defaultCore.config
    configureCommands({ modelCredentials: { deepseek: 'in-place' } })
    expect(defaultCore.config).toBe(ref) // 同一引用（Object.assign 而非替换）
    expect(ref.modelCredentials.deepseek).toBe('in-place') // 字段已被就地改写
  })

  it('默认命令把 defaultCore 作为 core 传进 runSession（穿线口径：core 放 opts 内、不改参数位）', () => {
    configureCommands({ modelCredentials: { deepseek: 'k' } })
    newSession()
    sendMessage('hi')
    // 既有断言（call[2].apiKey）不受影响，core 只是 opts 里新增的一个字段。
    expect(vi.mocked(runSession).mock.calls[0][2].core).toBe(defaultCore)
  })

  it('createCoreInstance({config}) 的 config/store 与 defaultCore 隔离（第 3 期雏形）', () => {
    // 独立 config：configureCommands 只改 defaultCore.config，不碰隔离实例。
    const iso = createCoreInstance({ config: { modelCredentials: { deepseek: 'iso-key' } } })
    configureCommands({ modelCredentials: { deepseek: 'default-key' } })
    expect(iso.config.modelCredentials.deepseek).toBe('iso-key')
    expect(defaultCore.config.modelCredentials.deepseek).toBe('default-key')

    // 独立 store：在 iso 登记会话、以 iso 作 core 写 items —— 只落 iso 的 store，defaultCore 无此内容。
    const id = 'iso-sess'
    const meta: SessionMeta = {
      id,
      title: 't',
      settings: { vendor: 'deepseek', model: 'm' },
      createdAt: 0,
      updatedAt: 0,
    }
    iso.rootStore.setter(sessionsAtom, { [id]: meta })
    appendItem(id, { id: 'i1', createdAt: 1, item: { role: 'user', content: 'x' } }, iso)
    expect(iso.getSessionStore(id).store.getter(itemsAtom)).toHaveLength(1)
    // defaultCore 没登记该会话 → 其 store 天然为空（隔离，写入没串台到默认实例）。
    expect(defaultCore.getSessionStore(id).store.getter(itemsAtom)).toHaveLength(0)
  })
})

describe('createCommands 工厂（第 3 期 · 可绑定任意 core）', () => {
  it('模块级命令 = createCommands() 成员（绑 defaultCore）：newSession 写进 defaultCore 视图 rootStore', () => {
    const id = newSession()
    // rootStore 就是 defaultCore.rootStore 的视图；模块级 newSession 绑的是 defaultCore。
    expect(rootStore.getter(sessionsAtom)[id]).toBeTruthy()
  })

  it('createCommands(iso) 的命令绑 iso：newSession 只写进 iso.rootStore，不进 defaultCore', () => {
    const iso = createCoreInstance()
    const cmds = createCommands(iso)

    const id = cmds.newSession({ title: 'iso-only' })

    expect(iso.rootStore.getter(sessionsAtom)[id]?.title).toBe('iso-only')
    expect(iso.rootStore.getter(activeSessionIdAtom)).toBe(id)
    // defaultCore（= rootStore 视图）没这条会话。
    expect(rootStore.getter(sessionsAtom)[id]).toBeUndefined()
  })

  it('createCommands(iso).sendMessage 以 iso 作 core、取 iso.config.apiKey、只调 iso.abort（不碰 defaultCore.abort）', () => {
    const iso = createCoreInstance({ config: { modelCredentials: { deepseek: 'iso-key' } } })
    const beginIso = vi.spyOn(iso.abort, 'beginRun').mockImplementation(() => new AbortController().signal)
    const cmds = createCommands(iso)

    const id = cmds.newSession() // deepseek 默认
    cmds.sendMessage('hi')

    // 起 run 走 iso 自己的 abort；beforeEach 建于 defaultCore.abort 的 beginRun spy 不被调。
    expect(beginIso).toHaveBeenCalledWith(id)
    expect(beginRun).not.toHaveBeenCalled()

    // runSession 收到的 core===iso、apiKey 取自 iso.config。
    const call = vi.mocked(runSession).mock.calls[0]
    expect(call[0]).toBe(id)
    expect(call[2].core).toBe(iso)
    expect(call[2].apiKey).toBe('iso-key')
  })
})
