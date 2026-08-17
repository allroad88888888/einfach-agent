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
}))

vi.mock('@web-agent/persistence-idb', () => ({
  createIndexedDbSessionsPersistence: drivers.createIndexedDbSessionsPersistence,
  createIndexedDbRecoveryDriver: drivers.createIndexedDbRecoveryDriver,
  createIndexedDbHistoryLogDriver: drivers.createIndexedDbHistoryLogDriver,
}))
vi.mock('@web-agent/persistence-sqlite', () => ({
  createSqlitePersistence: drivers.createSqlitePersistence,
  createSqliteRecoveryDriver: drivers.createSqliteRecoveryDriver,
  createSqliteHistoryLogDriver: drivers.createSqliteHistoryLogDriver,
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

  it('browser host gets one IndexedDB session/recovery/history-log bundle', async () => {
    await expect(createHostPersistenceDrivers(false)).resolves.toEqual(drivers.browser)
    expect(drivers.createSqlitePersistence).not.toHaveBeenCalled()
    expect(drivers.createSqliteRecoveryDriver).not.toHaveBeenCalled()
    expect(drivers.createSqliteHistoryLogDriver).not.toHaveBeenCalled()
  })

  it('desktop host gets one SQLite session/recovery/history-log bundle', async () => {
    await expect(createHostPersistenceDrivers(true)).resolves.toEqual(drivers.desktop)
    expect(drivers.createIndexedDbSessionsPersistence).not.toHaveBeenCalled()
    expect(drivers.createIndexedDbRecoveryDriver).not.toHaveBeenCalled()
    expect(drivers.createIndexedDbHistoryLogDriver).not.toHaveBeenCalled()
  })
})
