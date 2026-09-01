import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHostPersistenceDrivers } from './persistenceDrivers'

const drivers = vi.hoisted(() => ({
  browser: {
    sessions: { kind: 'idb-sessions' },
    recovery: { kind: 'idb-recovery' },
    historyLog: { kind: 'idb-history-log' },
  },
  sqlite: {
    sessions: { kind: 'sqlite-sessions' },
    recovery: { kind: 'sqlite-recovery' },
    historyLog: { kind: 'sqlite-history-log' },
  },
  createIndexedDbSessionsPersistence: vi.fn(),
  createIndexedDbRecoveryDriver: vi.fn(),
  createIndexedDbHistoryLogDriver: vi.fn(),
  createSqlitePersistence: vi.fn(),
  createSqliteRecoveryDriver: vi.fn(),
  createSqliteHistoryLogDriver: vi.fn(),
  // P1 的执行面注入槽。这里是**整份模块替换**，新导出不列进来就是 undefined，被调用时 TypeError
  // ——所以它必须在册；断言在下面「两态各注入各的执行面」那几条。
  configureSqlExecutor: vi.fn(),
  // 执行面被 mock 成一个哨兵，用来断言「注入的确实是它」。真实实现要发 HTTP，不该在这里发生。
  serverExecutor: { kind: 'server-sql-executor' },
  loadServerSqlExecutor: vi.fn(),
  rollout: { kind: 'server-rollout' },
  createServerAgentRolloutDriver: vi.fn(),
  history: { kind: 'server-history' },
  createServerAgentHistoryCapability: vi.fn(),
}))

vi.mock('@einfach-agent/persistence-idb', () => ({
  createIndexedDbSessionsPersistence: drivers.createIndexedDbSessionsPersistence,
  createIndexedDbRecoveryDriver: drivers.createIndexedDbRecoveryDriver,
  createIndexedDbHistoryLogDriver: drivers.createIndexedDbHistoryLogDriver,
}))
vi.mock('@einfach-agent/persistence-sqlite', () => ({
  createSqlitePersistence: drivers.createSqlitePersistence,
  createSqliteRecoveryDriver: drivers.createSqliteRecoveryDriver,
  createSqliteHistoryLogDriver: drivers.createSqliteHistoryLogDriver,
  configureSqlExecutor: drivers.configureSqlExecutor,
}))
vi.mock('./serverSqlExecutor', () => ({ loadServerSqlExecutor: drivers.loadServerSqlExecutor }))
vi.mock('./serverAgentRolloutDriver', () => ({ createServerAgentRolloutDriver: drivers.createServerAgentRolloutDriver }))
vi.mock('./serverAgentHistoryCapability', () => ({
  createServerAgentHistoryCapability: drivers.createServerAgentHistoryCapability,
}))

/** 取出本次 `configureSqlExecutor` 收到的 loader 并求值——注入的是不是那一态的执行面只能这样问。 */
async function resolveInjectedExecutor(): Promise<unknown> {
  const loader = drivers.configureSqlExecutor.mock.calls[0]?.[0] as (() => Promise<unknown>) | undefined
  expect(loader).toBeTypeOf('function')
  return loader!()
}

describe('host persistence drivers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    drivers.createIndexedDbSessionsPersistence.mockReturnValue(drivers.browser.sessions)
    drivers.createIndexedDbRecoveryDriver.mockReturnValue(drivers.browser.recovery)
    drivers.createSqlitePersistence.mockReturnValue({
      sessions: drivers.sqlite.sessions,
    })
    drivers.createSqliteRecoveryDriver.mockReturnValue(drivers.sqlite.recovery)
    drivers.createIndexedDbHistoryLogDriver.mockReturnValue(drivers.browser.historyLog)
    drivers.createSqliteHistoryLogDriver.mockReturnValue(drivers.sqlite.historyLog)
    drivers.loadServerSqlExecutor.mockResolvedValue(drivers.serverExecutor)
    drivers.createServerAgentRolloutDriver.mockReturnValue(drivers.rollout)
    drivers.createServerAgentHistoryCapability.mockReturnValue(drivers.history)
  })

  it('static host gets one IndexedDB session/recovery/history-log bundle', async () => {
    await expect(createHostPersistenceDrivers({ kind: 'static', reason: 'unreachable' }))
      .resolves.toEqual(drivers.browser)
    expect(drivers.createSqlitePersistence).not.toHaveBeenCalled()
    expect(drivers.createSqliteRecoveryDriver).not.toHaveBeenCalled()
    expect(drivers.createSqliteHistoryLogDriver).not.toHaveBeenCalled()
    expect(drivers.createServerAgentRolloutDriver).not.toHaveBeenCalled()
    expect(drivers.createServerAgentHistoryCapability).not.toHaveBeenCalled()
  })

  // P3 的判据条款：server 宿主有本机 Node 后端，会话必须落**服务端的 SQLite**（与 CLI 同一个
  // 库文件），不再是浏览器本地的 IndexedDB。留在 IndexedDB 的后果不会报错——它只是让同一台机器上
  // 的两个前壳看到两份互不相干的历史。
  it('server host gets the SQLite bundle, not the IndexedDB one', async () => {
    await expect(createHostPersistenceDrivers({ kind: 'server', platform: 'linux' }))
      .resolves.toEqual({
        ...drivers.sqlite,
        agentRollout: drivers.rollout,
        agentHistory: drivers.history,
      })
    expect(drivers.createIndexedDbSessionsPersistence).not.toHaveBeenCalled()
    expect(drivers.createIndexedDbRecoveryDriver).not.toHaveBeenCalled()
    expect(drivers.createIndexedDbHistoryLogDriver).not.toHaveBeenCalled()
    expect(drivers.createServerAgentRolloutDriver).toHaveBeenCalledOnce()
    expect(drivers.createServerAgentHistoryCapability).toHaveBeenCalledOnce()
  })

  // P1：注入 SQL 执行面与「这一态用 SQLite」的判断必须同生共死，分开写就会有「选了 SQLite 却
  // 没配执行面」的中间态。收的是 loader（函数）而不是已打开的连接——所以两态的执行面在这一刻
  // 都还没被拉进模块图。
  it('only the SQLite host injects a SQL executor, and it injects a loader', async () => {
    await createHostPersistenceDrivers({ kind: 'static', reason: 'unreachable' })
    expect(drivers.configureSqlExecutor).not.toHaveBeenCalled()

    await createHostPersistenceDrivers({ kind: 'server', platform: 'linux' })
    expect(drivers.configureSqlExecutor).toHaveBeenCalledTimes(1)
    // 收的是 loader（函数）而不是已打开的连接——所以执行面此刻还没被拉进模块图。
    expect(drivers.configureSqlExecutor.mock.calls[0]?.[0]).toBeTypeOf('function')
    expect(drivers.loadServerSqlExecutor).not.toHaveBeenCalled()
  })

  // 光断言「注入了一个函数」不够：解析出来的必须真的是打到本机后端的那条执行面。
  it('server injects the HTTP executor', async () => {
    await createHostPersistenceDrivers({ kind: 'server', platform: 'macos' })
    await expect(resolveInjectedExecutor()).resolves.toBe(drivers.serverExecutor)
  })
})
