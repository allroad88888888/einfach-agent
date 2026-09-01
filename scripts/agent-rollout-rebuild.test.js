import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { AGENT_ROLLOUT_MAX_LINE_BYTES, encodeAgentRolloutRecord } from '../packages/agent-core/src/history/rolloutRecordCodec.ts'
import { closeSqliteConnections, createNodeSqlExecutorLoader } from '../packages/host-node/src/sqlite/index.ts'
import { resolveRolloutHistoryPath } from '../packages/host-node/src/rollout/rolloutPath.ts'
import { rebuild } from './agent-rollout-rebuild.js'

const roots = []

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rollout-rebuild-'))
  roots.push(root)
  const appData = join(root, 'app-data')
  const target = { kind: 'root', conversationId: 'conversation' }
  const source = resolveRolloutHistoryPath(appData, target)
  await mkdir(dirname(source.filePath), { recursive: true })
  const record = (ordinal, changes = {}) => ({ schemaVersion: 1, historyId: source.historyId, rolloutOrdinal: ordinal,
    recordedAt: '2026-09-01T00:00:00.000Z', mutationType: 'session_meta', target, title: 'Fixture', createdAt: 1, updatedAt: 1, ...changes })
  await writeFile(source.filePath, `${encodeAgentRolloutRecord(record(0))}\n`)
  return { root, appData, databasePath: join(root, 'projection.db'), source, record }
}

function options(value) {
  return { rolloutRoot: join(value.appData, 'rollouts'), databasePath: value.databasePath }
}

async function projection(databasePath) {
  const executor = await createNodeSqlExecutorLoader({ databasePath }, 'persistence')()
  const tables = ['agent_rollout_catalog', 'agent_rollout_items', 'agent_rollout_turns', 'agent_rollout_events', 'agent_rollout_projection_state']
  const result = {}
  for (const table of tables) result[table] = await executor.select(`SELECT * FROM ${table} ORDER BY 1`)
  await closeSqliteConnections()
  return result
}

async function seed(value) {
  await rebuild({ ...options(value), write: true })
  return { database: await readFile(value.databasePath), projection: await projection(value.databasePath) }
}

afterEach(async () => {
  await closeSqliteConnections()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('agent-rollout-rebuild', () => {
  it('leaves SQLite unchanged in dry-run and rebuilds only with --write', async () => {
    const value = await fixture()
    await expect(rebuild(options(value))).resolves.toMatchObject({ action: 'dry-run', files: 1 })
    await expect(rebuild({ ...options(value), write: true })).resolves.toMatchObject({ action: 'rebuilt', records: 1 })
    await expect(projection(value.databasePath)).resolves.toMatchObject({ agent_rollout_catalog: [expect.objectContaining({ title: 'Fixture' })] })
  })

  it.each([
    ['first path mismatch', (value) => `${encodeAgentRolloutRecord(value.record(0, { historyId: 'root:wrong', target: { kind: 'root', conversationId: 'other' } }))}\n`],
    ['later identity', (value) => `${encodeAgentRolloutRecord(value.record(0))}\n${encodeAgentRolloutRecord(value.record(1, { historyId: 'root:wrong' }))}\n`],
    ['later target', (value) => `${encodeAgentRolloutRecord(value.record(0))}\n${encodeAgentRolloutRecord(value.record(1, { historyId: 'root:wrong', target: { kind: 'root', conversationId: 'other' } }))}\n`],
    ['nonzero start', (value) => `${encodeAgentRolloutRecord(value.record(1))}\n`],
    ['duplicate ordinal', (value) => `${encodeAgentRolloutRecord(value.record(0))}\n${encodeAgentRolloutRecord(value.record(0))}\n`],
    ['ordinal gap', (value) => `${encodeAgentRolloutRecord(value.record(0))}\n${encodeAgentRolloutRecord(value.record(2))}\n`],
    ['unterminated', (value) => encodeAgentRolloutRecord(value.record(0))],
    ['oversized', () => `${'x'.repeat(AGENT_ROLLOUT_MAX_LINE_BYTES + 1)}\n`],
  ])('preserves prior projection and source for %s', async (_name, corrupt) => {
    const value = await fixture()
    const original = await seed(value)
    await writeFile(value.source.filePath, corrupt(value))
    const checksum = await readFile(value.source.filePath)
    await expect(rebuild({ ...options(value), write: true })).rejects.toThrow(new RegExp(`${value.source.filePath}:`))
    await expect(readFile(value.source.filePath)).resolves.toEqual(checksum)
    await expect(readFile(value.databasePath)).resolves.toEqual(original.database)
    await expect(projection(value.databasePath)).resolves.toEqual(original.projection)
  })

  it('keeps non-projection and future rollout tables during an exact-schema rebuild', async () => {
    const value = await fixture()
    await seed(value)
    const executor = await createNodeSqlExecutorLoader({ databasePath: value.databasePath }, 'persistence')()
    await executor.execute('CREATE TABLE agent_rollout_future_keep (value TEXT)')
    await executor.execute("INSERT INTO agent_rollout_future_keep (value) VALUES ('sentinel')")
    await executor.execute('CREATE TABLE unrelated_keep (value TEXT)')
    await executor.execute("INSERT INTO unrelated_keep (value) VALUES ('sentinel')")
    await closeSqliteConnections()
    await rebuild({ ...options(value), write: true })
    const check = await createNodeSqlExecutorLoader({ databasePath: value.databasePath }, 'persistence')()
    await expect(check.select('SELECT value FROM agent_rollout_future_keep')).resolves.toEqual([{ value: 'sentinel' }])
    await expect(check.select('SELECT value FROM unrelated_keep')).resolves.toEqual([{ value: 'sentinel' }])
  })

  it('rejects broad aliases and a database inside the rollout tree before I/O', async () => {
    const value = await fixture()
    const workspaceAlias = join(value.root, 'rollouts')
    const homeAlias = join(value.root, 'home-rollouts')
    await symlink(process.cwd(), workspaceAlias)
    await symlink(homedir(), homeAlias)
    await expect(rebuild({ rolloutRoot: workspaceAlias, databasePath: value.databasePath })).rejects.toThrow('refuses broad path')
    await expect(rebuild({ rolloutRoot: homeAlias, databasePath: value.databasePath })).rejects.toThrow('refuses broad path')
    const rolloutAlias = join(value.root, 'rollout-alias')
    await symlink(join(value.appData, 'rollouts'), rolloutAlias)
    const inside = join(rolloutAlias, 'new-projection.db')
    await expect(rebuild({ rolloutRoot: join(value.appData, 'rollouts'), databasePath: inside, write: true }))
      .rejects.toThrow('must be disjoint')
    await expect(readFile(inside)).rejects.toThrow()
  })
})
