import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRolloutDriver, AgentRolloutReconcileResult } from '@einfach-agent/core/history'
import { closeSqliteConnections } from '@einfach-agent/host-node'
import type { CliPersistenceCore } from './persistence'
import { assembleCliPersistence } from './persistence'

const roots: string[] = []
async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cli-history-persistence-'))
  roots.push(root)
  return join(root, 'web-agent.db')
}
afterEach(async () => {
  await closeSqliteConnections()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function core(): CliPersistenceCore {
  return {
    persistence: {
      configure: vi.fn(),
      flushRecovery: vi.fn(async () => undefined),
    },
    findSessionStore: vi.fn(),
  } as unknown as CliPersistenceCore
}

function rollout(result: AgentRolloutReconcileResult): AgentRolloutDriver {
  return {
    append: vi.fn(async () => ({ records: [] })),
    reconcile: vi.fn(async () => result),
    flush: vi.fn(async () => undefined),
  }
}

describe('CLI rollout persistence assembly', () => {
  it('rejects a source warning before execution can continue', async () => {
    const assembled = await assembleCliPersistence(core(), {
      homeDir: '/tmp/home', databasePath: await databasePath(),
      agentRolloutDriver: rollout({ histories: [{ historyId: 'x', recordsApplied: 0, nextByteOffset: 0,
        warning: { kind: 'source', code: 'CORRUPT', message: 'bad JSONL' } }] }),
    })

    await expect(assembled.reconcile()).rejects.toThrow('bad JSONL')
  })

  it('reports a projection warning and permits startup', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const assembled = await assembleCliPersistence(core(), {
      homeDir: '/tmp/home', databasePath: await databasePath(),
      agentRolloutDriver: rollout({ histories: [{ historyId: 'x', recordsApplied: 0, nextByteOffset: 0,
        warning: { kind: 'projection', code: 'LAG', message: 'projection unavailable' } }] }),
    })

    await expect(assembled.reconcile()).resolves.toMatchObject({ histories: [{ historyId: 'x' }] })
    expect(warning).toHaveBeenCalledWith('[agent-rollout]', 'projection unavailable')
    warning.mockRestore()
  })

  it('configures and returns the same borrowed history provider identity', async () => {
    const instance = core()
    const assembled = await assembleCliPersistence(instance, {
      homeDir: '/tmp/home', databasePath: await databasePath(),
      agentRolloutDriver: rollout({ histories: [] }),
    })

    expect(instance.persistence.configure).toHaveBeenCalledWith(expect.objectContaining({
      agentRollout: assembled.agentRollout,
      agentHistory: assembled.agentHistory,
    }))
  })
})
