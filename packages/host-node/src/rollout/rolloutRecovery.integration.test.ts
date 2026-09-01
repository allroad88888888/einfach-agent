import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createStore } from '@einfach/core'

import type { AgentRolloutMutationV1 } from '@einfach-agent/core/history'
import type { SessionMeta } from '@einfach-agent/core'
import { configureSqlExecutor, createSqliteRecoveryDriver } from '../../../persistence-sqlite/src/index'
import { captureRecoverySnapshot } from '../../../agent-core/src/state/recoveryProjection'
import { sessionsAtom } from '../../../agent-core/src/state/rootAtoms'
import { itemsAtom } from '../../../agent-core/src/state/sessionAtoms'
import { createAgentRolloutCoordinator } from '../../../agent-core/src/runtime/agentRolloutCoordinator'
import { createChildRolloutRecorder } from '../../../agent-core/src/subagents/childRolloutRecorder'
import { createSqliteExecutor } from '../sqlite/nodeSqliteExecutor'
import { dropRolloutProjectionSchema } from './projectionSchema'
import { resolveRolloutHistoryPath } from './rolloutPath'
import { createNodeAgentRolloutDriver } from './service'

const target = { kind: 'root', conversationId: 'integration-root' } as const
const serviceUrl = pathToFileURL(join(process.cwd(), 'packages/host-node/src/rollout/service.ts')).href
const executorUrl = pathToFileURL(join(process.cwd(), 'packages/host-node/src/sqlite/nodeSqliteExecutor.ts')).href
let roots: string[] = []

function item(id: string, ordinal: number): AgentRolloutMutationV1 {
  return { mutationType: 'item_upsert', target, itemId: id, itemOrdinal: ordinal, createdAt: ordinal,
    item: { role: 'user', content: id }, pending: false, planStageId: null }
}

function runProcess(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--eval', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)))
  })
}

function writerScript(root: string, prefix: string): string {
  return `Promise.all([import('node:sqlite'),import(${JSON.stringify(serviceUrl)}),import(${JSON.stringify(executorUrl)})]).then(async ([sqlite,service,sql])=>{
    const db=new sqlite.DatabaseSync(${JSON.stringify(join(root, 'projection.db'))});
    const target={kind:'root',conversationId:'integration-root'};
    const driver=service.createNodeAgentRolloutDriver({appDataDirectory:${JSON.stringify(root)},executor:sql.createSqliteExecutor(db,${JSON.stringify(prefix)})});
    for(let batch=0;batch<3;batch++){const mutations=[];for(let n=0;n<2;n++){const i=batch*2+n;mutations.push({mutationType:'item_upsert',target,itemId:${JSON.stringify(prefix)}+'-'+i,itemOrdinal:i,createdAt:i,item:{role:'user',content:${JSON.stringify(prefix)}+'-'+i},pending:false,planStageId:null})}await driver.append(target,mutations)}
    await driver.flush();db.close();
  })`
}

function projection(database: DatabaseSync) {
  const table = (name: string, order: string) => database.prepare(`SELECT * FROM ${name} ORDER BY ${order}`).all()
  return {
    catalog: table('agent_rollout_catalog', 'history_id'),
    events: table('agent_rollout_events', 'history_id, rollout_ordinal'),
    items: table('agent_rollout_items', 'history_id, item_id'),
    turns: table('agent_rollout_turns', 'history_id, turn_key'),
    state: table('agent_rollout_projection_state', 'source_path'),
  }
}

function rowCounts(snapshot: ReturnType<typeof projection>) {
  return Object.fromEntries(Object.entries(snapshot).map(([name, rows]) => [name, rows.length]))
}

afterEach(async () => {
  configureSqlExecutor(undefined)
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots = []
})

describe('rollout physical recovery integration', () => {
  it('serializes multiple batches from two independent processes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rollout-processes-')); roots.push(root)
    await Promise.all([runProcess(writerScript(root, 'server')), runProcess(writerScript(root, 'cli'))])
    const source = resolveRolloutHistoryPath(root, target).filePath
    const bytes = await readFile(source)
    const lines = bytes.toString('utf8').trimEnd().split('\n').map((line) => JSON.parse(line))
    expect(bytes.at(-1)).toBe(10)
    expect(lines.map(({ rolloutOrdinal }) => rolloutOrdinal)).toEqual([...Array(12).keys()])
    const database = new DatabaseSync(join(root, 'projection.db'))
    expect(rowCounts(projection(database))).toEqual({ catalog: 1, events: 12, items: 12, turns: 0, state: 1 })
    database.close()
  })

  it('reconciles exactly after termination between source fsync and projection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rollout-crash-')); roots.push(root)
    const script = `Promise.all([import('node:sqlite'),import(${JSON.stringify(serviceUrl)}),import(${JSON.stringify(executorUrl)})]).then(async ([sqlite,service,sql])=>{
      const db=new sqlite.DatabaseSync(${JSON.stringify(join(root, 'projection.db'))});const base=sql.createSqliteExecutor(db,'crash');let stateReads=0;
      const executor={execute:base.execute.bind(base),select(q,p){if(q.includes('agent_rollout_projection_state')&&++stateReads===2){process.send?.('after-fsync');return new Promise(()=>{})}return base.select(q,p)}};
      const target={kind:'root',conversationId:'integration-root'};const mutation={mutationType:'item_upsert',target,itemId:'durable',itemOrdinal:0,createdAt:1,item:{role:'user',content:'durable'},pending:false,planStageId:null};
      await service.createNodeAgentRolloutDriver({appDataDirectory:${JSON.stringify(root)},executor}).append(target,[mutation]);
    })`
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--eval', script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      let stderr = ''; child.stderr!.on('data', (chunk) => { stderr += String(chunk) })
      child.once('error', reject)
      child.once('message', () => child.kill('SIGTERM'))
      child.once('exit', (code, signal) => signal === 'SIGTERM' ? resolve() : reject(new Error(stderr || `exit ${code}`)))
    })
    const database = new DatabaseSync(join(root, 'projection.db'))
    const driver = createNodeAgentRolloutDriver({ appDataDirectory: root,
      executor: createSqliteExecutor(database, 'restart') })
    await driver.reconcile(); await driver.reconcile()
    expect(rowCounts(projection(database))).toEqual({ catalog: 1, events: 1, items: 1, turns: 0, state: 1 })
    database.close()
  })

  it('backfills a SQLite-only root once and preserves root/child semantics after restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rollout-legacy-')); roots.push(root)
    const databasePath = join(root, 'projection.db')
    let database = new DatabaseSync(databasePath)
    let executor = createSqliteExecutor(database, 'legacy-first')
    configureSqlExecutor(async () => executor)
    const recovery = createSqliteRecoveryDriver()
    const rootStore = createStore(); const store = createStore()
    const meta: SessionMeta = {
      id: 'legacy', title: 'Legacy', settings: { vendor: 'v', model: 'm' }, createdAt: 1, updatedAt: 2,
    }
    rootStore.setter(sessionsAtom, { legacy: meta })
    store.setter(itemsAtom, [
      { id: 'a', createdAt: 1, item: { role: 'user', content: 'A' } },
      { id: 'b', createdAt: 2, item: { role: 'assistant', content: 'B' } },
    ])
    const legacy = captureRecoverySnapshot(store, { rootStore, sessionId: 'legacy', generation: 7, capturedAt: 9 })
    await recovery.saveLatest('legacy', legacy)
    const firstDriver = createNodeAgentRolloutDriver({ appDataDirectory: root, executor,
      store: { now: () => new Date('2026-09-01T01:00:00.000Z') } })
    await createAgentRolloutCoordinator(firstDriver).capture((await recovery.loadLatest('legacy'))!)
    await firstDriver.flush()
    const source = resolveRolloutHistoryPath(root, { kind: 'root', conversationId: 'legacy' }).filePath
    const firstLines = (await readFile(source, 'utf8')).trimEnd().split('\n').length
    database.close()

    database = new DatabaseSync(databasePath)
    executor = createSqliteExecutor(database, 'legacy-restart')
    configureSqlExecutor(async () => executor)
    const restartedRecovery = createSqliteRecoveryDriver()
    const restartedDriver = createNodeAgentRolloutDriver({ appDataDirectory: root, executor,
      store: { now: () => new Date('2026-09-01T02:00:00.000Z') } })
    const coordinator = createAgentRolloutCoordinator(restartedDriver)
    await coordinator.capture((await restartedRecovery.loadLatest('legacy'))!)
    expect((await readFile(source, 'utf8')).trimEnd().split('\n')).toHaveLength(firstLines)

    store.setter(itemsAtom, [
      { id: 'b', createdAt: 2, item: { role: 'assistant', content: 'B2' } },
      { id: 'c', createdAt: 3, item: { role: 'user', content: 'C' } },
    ])
    await coordinator.capture(captureRecoverySnapshot(store, {
      rootStore, sessionId: 'legacy', generation: 8, capturedAt: 10,
    }))
    const child = createChildRolloutRecorder({
      driver: restartedDriver, conversationId: 'legacy', runId: 'child-run', agentPath: 'root-01', now: () => 11,
    })
    await child.recordInitial([{ role: 'system', content: 'system' }, { role: 'user', content: 'user' }])
    await child.recordItem({ role: 'assistant', content: null,
      tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'read', arguments: '{}' } }] })
    await child.recordItem({ role: 'tool', tool_call_id: 'tool-1', content: 'result' })
    await child.recordItem({ role: 'user', content: 'synthesis' })
    await child.recordItem({ role: 'assistant', content: 'done' })
    await child.recordSuccess(); await restartedDriver.flush()

    const rootHistory = resolveRolloutHistoryPath(root, { kind: 'root', conversationId: 'legacy' }).historyId
    const childHistory = resolveRolloutHistoryPath(root, {
      kind: 'child', conversationId: 'legacy', runId: 'child-run', agentPath: 'root-01',
    }).historyId
    const projected = projection(database)
    const rootItems = projected.items.filter((row) => row.history_id === rootHistory)
    expect(rootItems.map((row) => [row.item_id, row.item_ordinal, row.deleted])).toEqual([
      ['a', 0, 1], ['b', 0, 0], ['c', 1, 0],
    ])
    expect(JSON.parse(String(rootItems.find((row) => row.item_id === 'b')!.item_json))).toMatchObject({ content: 'B2' })
    const childRoles = projected.items.filter((row) => row.history_id === childHistory)
      .sort((left, right) => Number(left.item_ordinal) - Number(right.item_ordinal))
      .map((row) => JSON.parse(String(row.item_json)).role)
    expect(childRoles).toEqual(['system', 'user', 'assistant', 'tool', 'user', 'assistant'])
    expect(projected.catalog.find((row) => row.history_id === childHistory)!.complete).toBe(1)
    expect(projected.turns.find((row) => row.history_id === childHistory)!.status).toBe('done')
    database.close(); configureSqlExecutor(undefined)
  })

  it('rebuilds an equivalent projection solely from unchanged JSONL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rollout-rebuild-')); roots.push(root)
    const database = new DatabaseSync(join(root, 'projection.db'))
    const executor = createSqliteExecutor(database, 'rebuild')
    const driver = createNodeAgentRolloutDriver({ appDataDirectory: root, executor,
      store: { now: () => new Date('2026-09-01T00:00:00.000Z') } })
    await driver.append(target, [
      { mutationType: 'session_meta', target, title: 'Rebuild', createdAt: 1, updatedAt: 2 },
      { mutationType: 'turn_context', target, turnId: 'turn', itemIds: ['kept', 'removed'] },
      item('kept', 0), item('removed', 1),
      { mutationType: 'run_state', target, runId: 'run', turnId: 'turn', status: 'done', error: null },
    ])
    await driver.append(target, [{ mutationType: 'item_deleted', target, itemId: 'removed', reason: 'deleted' }])
    const before = projection(database)
    const source = resolveRolloutHistoryPath(root, target).filePath
    const checksum = createHash('sha256').update(await readFile(source)).digest('hex')
    expect(checksum).toBe('f3fba497b36bb0330475b0c77b5c3372c8bc0e03afb8f58abdfeea380d3530d6')
    await dropRolloutProjectionSchema(executor)
    await createNodeAgentRolloutDriver({ appDataDirectory: root, executor }).reconcile()
    expect(projection(database)).toEqual(before)
    expect(createHash('sha256').update(await readFile(source)).digest('hex')).toBe(checksum)
    expect(rowCounts(before)).toEqual({ catalog: 1, events: 6, items: 2, turns: 1, state: 1 })
    database.close()
  })
})
