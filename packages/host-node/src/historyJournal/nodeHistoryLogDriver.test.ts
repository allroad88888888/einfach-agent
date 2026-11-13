import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HistoryLogBatch } from '@einfach-agent/core/state/persistence'
import { createNodeHistoryLogDriver } from './nodeHistoryLogDriver'

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'undo-journal-'))
  roots.push(root)
  return { root, driver: createNodeHistoryLogDriver(root),
    path: join(root, 'history-journals', `${createHash('sha256').update('s').digest('hex')}.jsonl`) }
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

function batch(id: string, parent: string | null, cursor: number): HistoryLogBatch {
  return { version: 1, id, parent, operations: [
    { type: 'append', entry: { txId: id, ops: [{ key: 'slot', before: cursor - 1, after: cursor }] } },
    { type: 'setCursor', cursor },
  ] }
}

describe('local JSONL undo journal', () => {
  it('appends once per id, survives restart and selects an earlier committed head', async () => {
    const { root, driver, path } = await fixture()
    await driver.append('s', batch('a', null, 1))
    const original = await readFile(path, 'utf8')
    await driver.append('s', batch('b', 'a', 2))
    await driver.append('s', batch('b', 'a', 2))
    const persisted = await readFile(path, 'utf8')
    expect(persisted.startsWith(original)).toBe(true)
    expect(persisted.trim().split('\n')).toHaveLength(2)
    const restarted = createNodeHistoryLogDriver(root)
    expect((await restarted.load('s', 'a')).entries).toHaveLength(1)
    expect((await restarted.load('s', 'b')).cursor).toBe(2)
    await restarted.append('s', batch('c', 'a', 2))
    expect((await restarted.load('s', 'c')).entries.map((entry) => entry.txId)).toEqual(['a', 'c'])
  })

  it('recovers a torn uncommitted tail while preserving every complete record', async () => {
    const { root, driver, path } = await fixture()
    await driver.append('s', batch('a', null, 1))
    const prefix = await readFile(path, 'utf8')
    await appendFile(path, '{"sessionId":"s","batch":')
    const restarted = createNodeHistoryLogDriver(root)
    expect((await restarted.load('s', 'a')).cursor).toBe(1)
    await restarted.append('s', batch('b', 'a', 2))
    expect((await readFile(path, 'utf8')).startsWith(prefix)).toBe(true)
    expect((await createNodeHistoryLogDriver(root).load('s', 'b')).cursor).toBe(2)
  })

  it('rejects corruption, missing parents, conflicting retries and cross-session references', async () => {
    const { root, driver, path } = await fixture()
    await expect(driver.append('s', batch('b', 'missing', 1))).rejects.toThrow('parent')
    await driver.append('s', batch('a', null, 1))
    await expect(driver.append('s', batch('a', null, 2))).rejects.toThrow('conflict')
    await expect(driver.load('other', 'a')).rejects.toThrow('Missing')
    await appendFile(path, '{bad json}\n')
    await expect(createNodeHistoryLogDriver(root).load('s', 'a')).rejects.toThrow()
    await expect(driver.append('s', batch('b', 'a', 2))).rejects.toThrow()
  })

  it('serializes concurrent appends from separate host instances', async () => {
    const { root, driver, path } = await fixture()
    const other = createNodeHistoryLogDriver(root)
    await driver.append('s', batch('a', null, 1))
    await Promise.all([driver.append('s', batch('b', 'a', 2)), other.append('s', batch('c', 'a', 2))])
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(3)
    expect((await driver.load('s', 'b')).cursor).toBe(2)
    expect((await other.load('s', 'c')).cursor).toBe(2)
  })
})
