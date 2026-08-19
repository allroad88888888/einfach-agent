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
  // ——所以它必须在册；断言在下面「两态各注入各的执行面」那几条。
  configureSqlExecutor: vi.fn(),
  // 两态的执行面各被 mock 成一个哨兵，用来分辨「注入的到底是哪一个」。真实实现一个要拉进桌面
  // SQL 插件、一个要发 HTTP，都不该在这个用例里发生。
  tauriExecutor: { kind: 'tauri-sql-executor' },
  serverExecutor: { kind: 'server-sql-executor' },
  loadTauriSqlExecutor: vi.fn(),
  loadServerSqlExecutor: vi.fn(),
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
vi.mock('./tauriSqlExecutor', () => ({ loadTauriSqlExecutor: drivers.loadTauriSqlExecutor }))
vi.mock('./serverSqlExecutor', () => ({ loadServerSqlExecutor: drivers.loadServerSqlExecutor }))

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
      sessions: drivers.desktop.sessions,
    })
    drivers.createSqliteRecoveryDriver.mockReturnValue(drivers.desktop.recovery)
    drivers.createIndexedDbHistoryLogDriver.mockReturnValue(drivers.browser.historyLog)
    drivers.createSqliteHistoryLogDriver.mockReturnValue(drivers.desktop.historyLog)
    drivers.loadTauriSqlExecutor.mockResolvedValue(drivers.tauriExecutor)
    drivers.loadServerSqlExecutor.mockResolvedValue(drivers.serverExecutor)
  })

  it('static host gets one IndexedDB session/recovery/history-log bundle', async () => {
    await expect(createHostPersistenceDrivers({ kind: 'static', reason: 'unreachable' }))
      .resolves.toEqual(drivers.browser)
    expect(drivers.createSqlitePersistence).not.toHaveBeenCalled()
    expect(drivers.createSqliteRecoveryDriver).not.toHaveBeenCalled()
    expect(drivers.createSqliteHistoryLogDriver).not.toHaveBeenCalled()
  })

  // P3 的判据条款：server 宿主有本机 Node 后端，会话必须落**服务端的 SQLite**（与桌面版同一个
  // 库文件），不再是浏览器本地的 IndexedDB。留在 IndexedDB 的后果不会报错——它只是让同一台机器上
  // 的两个宿主看到两份互不相干的历史。
  it('server host gets the SQLite bundle, not the IndexedDB one', async () => {
    await expect(createHostPersistenceDrivers({ kind: 'server', platform: 'linux' }))
      .resolves.toEqual(drivers.desktop)
    expect(drivers.createIndexedDbSessionsPersistence).not.toHaveBeenCalled()
    expect(drivers.createIndexedDbRecoveryDriver).not.toHaveBeenCalled()
    expect(drivers.createIndexedDbHistoryLogDriver).not.toHaveBeenCalled()
  })

  it('desktop host gets one SQLite session/recovery/history-log bundle', async () => {
    await expect(createHostPersistenceDrivers({ kind: 'tauri' })).resolves.toEqual(drivers.desktop)
    expect(drivers.createIndexedDbSessionsPersistence).not.toHaveBeenCalled()
    expect(drivers.createIndexedDbRecoveryDriver).not.toHaveBeenCalled()
    expect(drivers.createIndexedDbHistoryLogDriver).not.toHaveBeenCalled()
  })

  // P1：注入 SQL 执行面与「这一态用 SQLite」的判断必须同生共死，分开写就会有「选了 SQLite 却
  // 没配执行面」的中间态。收的是 loader（函数）而不是已打开的连接——所以两态的执行面在这一刻
  // 都还没被拉进模块图。
  it('only the two SQLite hosts inject a SQL executor, and they inject a loader', async () => {
    await createHostPersistenceDrivers({ kind: 'static', reason: 'unreachable' })
    expect(drivers.configureSqlExecutor).not.toHaveBeenCalled()

    await createHostPersistenceDrivers({ kind: 'tauri' })
    expect(drivers.configureSqlExecutor).toHaveBeenCalledTimes(1)
    expect(drivers.configureSqlExecutor.mock.calls[0]?.[0]).toBeTypeOf('function')
    expect(drivers.loadTauriSqlExecutor).not.toHaveBeenCalled()
  })

  // 两态都用 SQLite，差别**只在执行面**：桌面走原生插件，server 走 `/api/invoke/sqlite_*`。
  // 光断言「注入了一个函数」分不出这两者——把桥接错的后果是浏览器去调 Tauri 插件（当场失败）
  // 或桌面端去发 HTTP（没有服务端在听）。
  it('desktop injects the Tauri executor and server injects the HTTP one', async () => {
    await createHostPersistenceDrivers({ kind: 'tauri' })
    await expect(resolveInjectedExecutor()).resolves.toBe(drivers.tauriExecutor)
    expect(drivers.loadServerSqlExecutor).not.toHaveBeenCalled()

    vi.clearAllMocks()
    drivers.createSqlitePersistence.mockReturnValue({ sessions: drivers.desktop.sessions })
    drivers.loadServerSqlExecutor.mockResolvedValue(drivers.serverExecutor)

    await createHostPersistenceDrivers({ kind: 'server', platform: 'macos' })
    await expect(resolveInjectedExecutor()).resolves.toBe(drivers.serverExecutor)
    expect(drivers.loadTauriSqlExecutor).not.toHaveBeenCalled()
  })
})
