import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHostPersistenceDrivers } from './persistenceDrivers'

const drivers = vi.hoisted(() => ({
  browser: {
    sessions: { kind: 'idb-sessions' },
    recovery: { kind: 'idb-recovery' },
    historyLog: { kind: 'idb-history-log' },
  },
  desktop: {
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
  // ——所以它必须在册；断言在下面「桌面态注入执行面」那条。
  configureSqlExecutor: vi.fn(),
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

describe('host persistence drivers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    drivers.createIndexedDbSessionsPersistence.mockReturnValue(drivers.browser.sessions)
    drivers.createIndexedDbRecoveryDriver.mockReturnValue(drivers.browser.recovery)
    drivers.createSqlitePersistence.mockReturnValue({
      sessions: drivers.desktop.sessions,
    })
    drivers.createSqliteRecoveryDriver.mockReturnValue(drivers.desktop.recovery)
    drivers.createIndexedDbHistoryLogDriver.mockReturnValue(drivers.browser.historyLog)
    drivers.createSqliteHistoryLogDriver.mockReturnValue(drivers.desktop.historyLog)
  })

  it('static host gets one IndexedDB session/recovery/history-log bundle', async () => {
    await expect(createHostPersistenceDrivers({ kind: 'static', reason: 'unreachable' }))
      .resolves.toEqual(drivers.browser)
    expect(drivers.createSqlitePersistence).not.toHaveBeenCalled()
    expect(drivers.createSqliteRecoveryDriver).not.toHaveBeenCalled()
    expect(drivers.createSqliteHistoryLogDriver).not.toHaveBeenCalled()
  })

  // server 宿主有本机能力，却**没有** SQLite：P 线之前浏览器侧读不到服务端的 SQLite 文件。
  // 这一条钉住的正是「有桥 ≠ 有 SQLite」——按 `kind !== 'static'` 分流会在这里变红。
  it('server host still gets the IndexedDB bundle until the P line lands', async () => {
    await expect(createHostPersistenceDrivers({ kind: 'server', platform: 'linux' }))
      .resolves.toEqual(drivers.browser)
    expect(drivers.createSqlitePersistence).not.toHaveBeenCalled()
    expect(drivers.createSqliteRecoveryDriver).not.toHaveBeenCalled()
    expect(drivers.createSqliteHistoryLogDriver).not.toHaveBeenCalled()
  })

  it('desktop host gets one SQLite session/recovery/history-log bundle', async () => {
    await expect(createHostPersistenceDrivers({ kind: 'tauri' })).resolves.toEqual(drivers.desktop)
    expect(drivers.createIndexedDbSessionsPersistence).not.toHaveBeenCalled()
    expect(drivers.createIndexedDbRecoveryDriver).not.toHaveBeenCalled()
    expect(drivers.createIndexedDbHistoryLogDriver).not.toHaveBeenCalled()
  })

  // P1：注入 SQL 执行面与「这一态用 SQLite」的判断必须同生共死，分开写就会有「选了 SQLite 却
  // 没配执行面」的中间态。收的是 loader（函数）而不是已打开的连接——所以桌面 SQL 插件在这一刻
  // 还没被拉进模块图，本用例也因此不需要 mock 它。
  it('only the desktop host injects a SQL executor, and it injects a loader', async () => {
    await createHostPersistenceDrivers({ kind: 'static', reason: 'unreachable' })
    await createHostPersistenceDrivers({ kind: 'server', platform: 'linux' })
    expect(drivers.configureSqlExecutor).not.toHaveBeenCalled()

    await createHostPersistenceDrivers({ kind: 'tauri' })
    expect(drivers.configureSqlExecutor).toHaveBeenCalledTimes(1)
    expect(drivers.configureSqlExecutor.mock.calls[0]?.[0]).toBeTypeOf('function')
  })
})
