import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import type { AgentHistoryTarget, AgentRolloutMutationV1 } from '@einfach-agent/core/history'
import { createSqliteExecutor } from '../sqlite/nodeSqliteExecutor'
import { createNodeAgentRolloutDriver } from './service'
import { resolveRolloutHistoryPath } from './rolloutPath'

const target: AgentHistoryTarget = { kind: 'root', conversationId: 'conversation' }
const execFileAsync = promisify(execFile)

function item(content: string): AgentRolloutMutationV1 {
  return { mutationType: 'item_upsert', target, itemId: 'item', itemOrdinal: 0, createdAt: 1,
    item: { role: 'user', content }, pending: false, planStageId: null }
}

describe('node rollout service', () => {
  let root: string | undefined
  let database: DatabaseSync | undefined

  afterEach(async () => {
    database?.close()
    database = undefined
    if (root) await rm(root, { recursive: true, force: true })
    root = undefined
  })

  async function setup(projector = {}) {
    root = await mkdtemp(join(tmpdir(), 'rollout-service-'))
    database = new DatabaseSync(join(root, 'projection.db'))
    return createNodeAgentRolloutDriver({ appDataDirectory: root,
      executor: createSqliteExecutor(database, 'rollout-service-test'), projector })
  }

  it('does not persist an equivalent item twice but persists an actual update', async () => {
    const driver = await setup()
    expect((await driver.append(target, [item('first')])).records).toHaveLength(1)
    expect((await driver.append(target, [item('first')])).records).toHaveLength(0)
    expect((await driver.append(target, [item('updated')])).records).toHaveLength(1)
  })

  it('keeps hot append validation near-linear and validates another driver tail', async () => {
    root = await mkdtemp(join(tmpdir(), 'rollout-service-linear-'))
    database = new DatabaseSync(join(root, 'projection.db'))
    let observed = 0
    const first = createNodeAgentRolloutDriver({ appDataDirectory: root,
      executor: createSqliteExecutor(database, 'rollout-linear-first'),
      sourceValidation: { chunkBytes: 13, onChunkRead(bytes) { observed += bytes } } })
    for (let index = 0; index < 8; index += 1) await first.append(target, [item(`first-${index}`)])
    const second = createNodeAgentRolloutDriver({ appDataDirectory: root,
      executor: createSqliteExecutor(database, 'rollout-linear-second') })
    await second.append(target, [item('other-driver')])
    await first.append(target, [item('final')])
    const path = resolveRolloutHistoryPath(root, target).filePath
    expect(observed).toBe((await readFile(path)).byteLength)
  })

  it('dedupes all mutation kinds across drivers and advances state within a batch', async () => {
    const first = await setup()
    const second = createNodeAgentRolloutDriver({ appDataDirectory: root!,
      executor: createSqliteExecutor(database!, 'rollout-service-second') })
    const all: AgentRolloutMutationV1[] = [
      { mutationType: 'session_meta', target, title: 'title', createdAt: 1, updatedAt: 2 },
      { mutationType: 'turn_context', target, turnId: 'turn', itemIds: ['item'] },
      item('same'),
      { mutationType: 'run_state', target, runId: 'run', turnId: 'turn', status: 'done', error: null },
      { mutationType: 'item_deleted', target, itemId: 'missing', reason: 'unknown tombstone' },
    ]
    expect((await first.append(target, [...all, ...all])).records).toHaveLength(all.length)
    expect((await second.append(target, all)).records).toHaveLength(0)
    const path = resolveRolloutHistoryPath(root!, target).filePath
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(all.length)
  })

  it('dedupes equivalent backfills across independent processes', async () => {
    root = await mkdtemp(join(tmpdir(), 'rollout-service-process-'))
    const serviceUrl = pathToFileURL(join(process.cwd(), 'packages/host-node/src/rollout/service.ts')).href
    const executorUrl = pathToFileURL(join(process.cwd(), 'packages/host-node/src/sqlite/nodeSqliteExecutor.ts')).href
    const script = `Promise.all([import('node:sqlite'),import(${JSON.stringify(serviceUrl)}),import(${JSON.stringify(executorUrl)})]).then(async ([sqlite,service,executor])=>{
      const db=new sqlite.DatabaseSync(${JSON.stringify(join(root, 'projection.db'))});
      const target={kind:'root',conversationId:'conversation'};
      const mutations=[{mutationType:'session_meta',target,title:'same',createdAt:1,updatedAt:1},{mutationType:'item_deleted',target,itemId:'unknown',reason:'same'}];
      const driver=service.createNodeAgentRolloutDriver({appDataDirectory:${JSON.stringify(root)},executor:executor.createSqliteExecutor(db,'process')});
      await driver.append(target,mutations); await driver.flush(); db.close();
    })`
    await Promise.all([0, 1].map(() => execFileAsync(process.execPath, ['--import', 'tsx', '--eval', script])))
    const path = resolveRolloutHistoryPath(root, target).filePath
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(2)
  })

  it('preserves an unknown tombstone and only dedupes the same tombstone reason', async () => {
    const driver = await setup()
    const deleted = (reason: string): AgentRolloutMutationV1 =>
      ({ mutationType: 'item_deleted', target, itemId: 'unknown', reason })
    expect((await driver.append(target, [deleted('first')])).records).toHaveLength(1)
    expect((await driver.append(target, [deleted('first')])).records).toHaveLength(0)
    expect((await driver.append(target, [deleted('changed')])).records).toHaveLength(1)
  })

  it('keeps source success when projection fails and reconcile later catches up', async () => {
    let fail = true
    const driver = await setup({ afterRecordUpsert() {
      if (fail) { fail = false; throw new Error('projection unavailable') }
    } })
    const appended = await driver.append(target, [item('durable')])
    expect(appended.records).toHaveLength(1)
    expect(appended.projectionWarning).toMatchObject({ kind: 'projection', code: 'ROLLOUT_PROJECTION_FAILED' })
    const reconciled = await driver.reconcile()
    expect(reconciled.histories).toHaveLength(1)
    expect(reconciled.histories[0]).not.toHaveProperty('warning')
    expect(reconciled.histories[0]?.recordsApplied).toBe(1)
  })

  it('writes source with a warning when pre-reconcile fails', async () => {
    let calls = 0
    const driver = await setup({ afterRecordUpsert() {
      calls += 1
      if (calls <= 2) throw new Error('projection remains unavailable')
    } })
    expect((await driver.append(target, [item('first')])).projectionWarning?.kind).toBe('projection')
    const second = await driver.append(target, [item('second')])
    expect(second.records).toHaveLength(1)
    expect(second.projectionWarning?.kind).toBe('projection')
    expect(second.projectionWarning?.message).toContain('projection remains unavailable')
  })

  it('discovers only canonical sources and locates canonical failures', async () => {
    const driver = await setup()
    await driver.append(target, [item('valid')])
    await writeFile(join(root!, 'rollouts', 'backup.jsonl'), 'not rollout\n')
    const canonical = resolveRolloutHistoryPath(root!, { kind: 'root', conversationId: 'broken' })
    await mkdir(join(canonical.filePath, '..'), { recursive: true })
    await writeFile(canonical.filePath, 'broken\n')
    const result = await driver.reconcile()
    expect(result.histories).toHaveLength(2)
    const failed = result.histories.find((history) => history.historyId === canonical.historyId)
    expect(failed?.warning?.message).toContain(canonical.filePath)
    expect(failed?.warning?.message).toContain(canonical.historyId)
    expect(failed?.warning?.kind).toBe('source')
  })

  it('rejects append after source corruption without extending the JSONL file', async () => {
    const driver = await setup()
    await driver.append(target, [item('valid')])
    const path = resolveRolloutHistoryPath(root!, target).filePath
    await writeFile(path, `${await readFile(path, 'utf8')}corrupt\n`)
    const before = await readFile(path, 'utf8')
    await expect(driver.append(target, [item('must-not-append')])).rejects.toThrow('corrupt rollout source')
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('rejects an ordinary post-fsync source validation failure while retaining evidence', async () => {
    root = await mkdtemp(join(tmpdir(), 'rollout-service-post-source-'))
    database = new DatabaseSync(join(root, 'projection.db'))
    const executor = createSqliteExecutor(database, 'post-source-test')
    const failing = createNodeAgentRolloutDriver({ appDataDirectory: root, executor,
      sourceValidation: { onChunkRead() { throw new Error('source validation unavailable') } } })
    await expect(failing.append(target, [item('durable-but-unconfirmed')]))
      .rejects.toThrow('source validation unavailable')
    const path = resolveRolloutHistoryPath(root, target).filePath
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(1)
    await expect(failing.flush()).rejects.toThrow('source validation unavailable')
    await expect(failing.flush()).resolves.toBeUndefined()

    const repaired = createNodeAgentRolloutDriver({ appDataDirectory: root, executor })
    expect((await repaired.append(target, [item('durable-but-unconfirmed')])).records).toHaveLength(0)
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it('does not let a prepared projection warning hide post-fsync source failure', async () => {
    const healthy = await setup()
    await healthy.append(target, [item('base')])
    const baseExecutor = createSqliteExecutor(database!, 'combined-source-test')
    const projectionFault = {
      execute: baseExecutor.execute.bind(baseExecutor),
      async select<T>(sql: string, params?: unknown[]): Promise<T> {
        if (sql.includes('agent_rollout_projection_state')) throw new Error('projection unavailable before append')
        return baseExecutor.select<T>(sql, params)
      },
    }
    let validationChunks = 0
    const failing = createNodeAgentRolloutDriver({ appDataDirectory: root!, executor: projectionFault,
      sourceValidation: { onChunkRead() {
        validationChunks += 1
        if (validationChunks === 2) throw new Error('post-append source read failed')
      } } })
    await expect(failing.append(target, [item('second')])).rejects.toThrow('post-append source read failed')
    const path = resolveRolloutHistoryPath(root!, target).filePath
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(2)
    await expect(failing.flush()).rejects.toThrow('post-append source read failed')

    const repaired = createNodeAgentRolloutDriver({ appDataDirectory: root!, executor: baseExecutor })
    expect((await repaired.append(target, [item('second')])).records).toHaveLength(0)
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(2)
  })

  it('rejects source failures', async () => {
    root = await mkdtemp(join(tmpdir(), 'rollout-service-source-fail-'))
    database = new DatabaseSync(join(root, 'projection.db'))
    const driver = createNodeAgentRolloutDriver({ appDataDirectory: '/dev/null',
      executor: createSqliteExecutor(database, 'rollout-source-fail-test') })
    await expect(driver.append(target, [item('lost')])).rejects.toThrow()
    await expect(driver.flush()).rejects.toThrow()
    await expect(driver.flush()).resolves.toBeUndefined()
  })
})
