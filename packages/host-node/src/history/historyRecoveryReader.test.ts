import { describe, expect, it, vi } from 'vitest'
import type { SqlExecutor } from '@einfach-agent/core/state/persistence'

const sqlite = vi.hoisted(() => {
  const listLatest = vi.fn(async () => [])
  return { listLatest, createSqliteRecoveryReader: vi.fn(() => ({ listLatest })) }
})

vi.mock('@einfach-agent/persistence-sqlite', () => sqlite)

import { createHistoryRecoveryReader } from './historyRecoveryReader'

describe('history recovery reader', () => {
  it('delegates recovery reads to the persistence facade without issuing writes', async () => {
    const executor = { execute: vi.fn(), select: vi.fn() } as unknown as SqlExecutor

    await expect(createHistoryRecoveryReader(executor).listLatest()).resolves.toEqual([])
    expect(sqlite.createSqliteRecoveryReader).toHaveBeenCalledWith(executor)
    expect(executor.execute).not.toHaveBeenCalled()
    expect(executor.select).not.toHaveBeenCalled()
  })
})
