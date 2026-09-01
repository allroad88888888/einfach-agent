import { describe, expect, it } from 'vitest'
import { createHistoryRecoveryReader } from './historyRecoveryReader'
import type { SqlExecutor } from '@einfach-agent/core/state/persistence'

describe('history recovery reader', () => {
  it('fails loudly on corrupt rows without writes', async () => {
    const executor = { execute: async () => { throw new Error('write') },
      select: async () => [{ session_id: 's', generation: 0, deleted: 0, snapshot: '{}' }] }
    await expect(createHistoryRecoveryReader(executor as unknown as SqlExecutor).listLatest()).rejects.toThrow('validation')
  })
})
