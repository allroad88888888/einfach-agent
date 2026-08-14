import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHostPersistenceDrivers } from './persistenceDrivers'

const drivers = vi.hoisted(() => ({
  browser: {
    history: { kind: 'idb-history' },
    sessions: { kind: 'idb-sessions' },
    recovery: { kind: 'idb-recovery' },
  },
  desktop: {
    history: { kind: 'sqlite-history' },
    sessions: { kind: 'sqlite-sessions' },
    recovery: { kind: 'sqlite-recovery' },
  },
  createIndexedDbHistoryDriver: vi.fn(),
  createIndexedDbSessionsPersistence: vi.fn(),
  createIndexedDbRecoveryDriver: vi.fn(),
  createSqlitePersistence: vi.fn(),
  createSqliteRecoveryDriver: vi.fn(),
}))

vi.mock('@web-agent/persistence-idb', () => ({
  createIndexedDbHistoryDriver: drivers.createIndexedDbHistoryDriver,
  createIndexedDbSessionsPersistence: drivers.createIndexedDbSessionsPersistence,
  createIndexedDbRecoveryDriver: drivers.createIndexedDbRecoveryDriver,
}))
vi.mock('@web-agent/persistence-sqlite', () => ({
  createSqlitePersistence: drivers.createSqlitePersistence,
  createSqliteRecoveryDriver: drivers.createSqliteRecoveryDriver,
}))

describe('host persistence drivers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    drivers.createIndexedDbHistoryDriver.mockReturnValue(drivers.browser.history)
    drivers.createIndexedDbSessionsPersistence.mockReturnValue(drivers.browser.sessions)
    drivers.createIndexedDbRecoveryDriver.mockReturnValue(drivers.browser.recovery)
    drivers.createSqlitePersistence.mockReturnValue({
      history: drivers.desktop.history,
      sessions: drivers.desktop.sessions,
    })
    drivers.createSqliteRecoveryDriver.mockReturnValue(drivers.desktop.recovery)
  })

  it('browser host gets one IndexedDB history/session/recovery bundle', async () => {
    await expect(createHostPersistenceDrivers(false)).resolves.toEqual(drivers.browser)
    expect(drivers.createSqlitePersistence).not.toHaveBeenCalled()
    expect(drivers.createSqliteRecoveryDriver).not.toHaveBeenCalled()
  })

  it('desktop host gets one SQLite history/session/recovery bundle', async () => {
    await expect(createHostPersistenceDrivers(true)).resolves.toEqual(drivers.desktop)
    expect(drivers.createIndexedDbHistoryDriver).not.toHaveBeenCalled()
    expect(drivers.createIndexedDbSessionsPersistence).not.toHaveBeenCalled()
    expect(drivers.createIndexedDbRecoveryDriver).not.toHaveBeenCalled()
  })
})
