import { execFile } from 'node:child_process'
import { mkdtemp, open, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import type { AgentHistoryTarget, AgentRolloutMutationV1 } from '@einfach-agent/core/history'
import { decodeAgentRolloutRecord } from '@einfach-agent/core/history'
import { describe, expect, it } from 'vitest'

import { createJsonlRolloutStore, MAX_ROLLOUT_APPEND_RECORDS } from './jsonlStore'
import { resolveRolloutHistoryPath } from './rolloutPath'

const target: AgentHistoryTarget = { kind: 'root', conversationId: 'conversation' }
const execFileAsync = promisify(execFile)

function mutation(itemId: string, selectedTarget = target): AgentRolloutMutationV1 {
  return { mutationType: 'item_deleted', target: selectedTarget, itemId, reason: 'test' }
}

async function directory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'jsonl-store-'))
}

async function records(root: string, selectedTarget = target) {
  const path = resolveRolloutHistoryPath(root, selectedTarget).filePath
  const contents = await readFile(path, 'utf8')
  expect(contents.endsWith('\n')).toBe(true)
  return contents.trimEnd().split('\n').map(decodeAgentRolloutRecord)
}

function deletedItemIds(persisted: Awaited<ReturnType<typeof records>>): string[] {
  return persisted.map((record) => {
    expect(record.mutationType).toBe('item_deleted')
    return record.mutationType === 'item_deleted' ? record.itemId : ''
  })
}

describe('createJsonlRolloutStore', () => {
  it('serializes concurrent batches with continuous, non-interleaved ordinals', async () => {
    const root = await directory()
    const first = createJsonlRolloutStore(root)
    const second = createJsonlRolloutStore(root)
    await Promise.all([
      first.append(target, [mutation('a'), mutation('b')]),
      second.append(target, [mutation('c'), mutation('d')]),
    ])
    const persisted = await records(root)
    expect(persisted.map((record) => record.rolloutOrdinal)).toEqual([0, 1, 2, 3])
    const ids = deletedItemIds(persisted)
    expect([['a', 'b', 'c', 'd'], ['c', 'd', 'a', 'b']]).toContainEqual(ids)
  })

  it('coordinates independent writer processes', async () => {
    const root = await directory()
    const moduleUrl = pathToFileURL(join(process.cwd(), 'packages/host-node/src/rollout/jsonlStore.ts')).href
    const writer = (prefix: string) => execFileAsync(process.execPath, ['--import', 'tsx', '--eval', `
      import(${JSON.stringify(moduleUrl)}).then(async ({ createJsonlRolloutStore }) => {
        const target = { kind: 'root', conversationId: 'conversation' };
        const mutation = (itemId) => ({ mutationType: 'item_deleted', target, itemId, reason: 'process-test' });
        await createJsonlRolloutStore(${JSON.stringify(root)}).append(target, [mutation('${prefix}1'), mutation('${prefix}2')]);
      });
    `])
    await Promise.all([writer('a'), writer('b')])
    const persisted = await records(root)
    expect(persisted.map((record) => record.rolloutOrdinal)).toEqual([0, 1, 2, 3])
    expect([['a1', 'a2', 'b1', 'b2'], ['b1', 'b2', 'a1', 'a2']]).toContainEqual(deletedItemIds(persisted))
  })

  it('runs prepared append inside the same cross-process target lock', async () => {
    const root = await directory()
    const first = createJsonlRolloutStore(root)
    const second = createJsonlRolloutStore(root)
    const seen: number[] = []
    await Promise.all([first, second].map((store, index) => store.appendPrepared(target, async ({ filePath }) => {
      const count = await readFile(filePath, 'utf8').then((text) => text.trim().split('\n').length, () => 0)
      seen.push(count)
      return { mutations: [mutation(String(index))] }
    })))
    expect(seen.sort()).toEqual([0, 1])
  })

  it('keeps different targets independent', async () => {
    const root = await directory()
    const child: AgentHistoryTarget = { kind: 'child', conversationId: 'conversation', runId: 'run', agentPath: 'agent' }
    const store = createJsonlRolloutStore(root)
    await Promise.all([store.append(target, [mutation('root')]), store.append(child, [mutation('child', child)])])
    expect((await records(root))[0]?.rolloutOrdinal).toBe(0)
    expect((await records(root, child))[0]?.rolloutOrdinal).toBe(0)
  })

  it('rejects an unterminated tail without changing it', async () => {
    const root = await directory()
    const path = resolveRolloutHistoryPath(root, target).filePath
    await import('node:fs/promises').then(({ mkdir }) => mkdir(dirname(path), { recursive: true }))
    await writeFile(path, '{"partial":true}')
    const store = createJsonlRolloutStore(root)
    await expect(store.append(target, [mutation('x')])).rejects.toThrow(/unterminated/)
    expect(await readFile(path, 'utf8')).toBe('{"partial":true}')
  })

  it('rejects mismatched targets and explicitly bounds batches', async () => {
    const root = await directory()
    const store = createJsonlRolloutStore(root)
    const child: AgentHistoryTarget = { kind: 'child', conversationId: 'c', runId: 'r', agentPath: 'a' }
    await expect(store.append(target, [mutation('x', child)])).rejects.toThrow(/does not match/)
    await expect(store.append(target, Array.from({ length: MAX_ROLLOUT_APPEND_RECORDS + 1 }, (_, i) => mutation(String(i)))))
      .rejects.toThrow(/exceeds/)
  })

  it('flush waits for all local queues, including failed appends', async () => {
    const root = await directory()
    const store = createJsonlRolloutStore(root)
    void store.append(target, [mutation('ok')])
    await store.flush()
    expect(deletedItemIds(await records(root))).toEqual(['ok'])
  })

  it('flush propagates an append failure that settled before flush began', async () => {
    const root = await directory()
    const store = createJsonlRolloutStore(root)
    const child: AgentHistoryTarget = { kind: 'child', conversationId: 'c', runId: 'r', agentPath: 'a' }
    await store.append(target, [mutation('wrong', child)]).catch(() => undefined)
    await expect(store.flush()).rejects.toThrow(/does not match/)
    await expect(store.flush()).resolves.toBeUndefined()
  })

  it('reads only a bounded tail even when the history file is large', async () => {
    const root = await directory()
    const store = createJsonlRolloutStore(root)
    await store.append(target, [mutation('first')])
    const path = resolveRolloutHistoryPath(root, target).filePath
    const original = await readFile(path)
    const handle = await open(path, 'w')
    try {
      await handle.truncate(32 * 1024 * 1024)
      const recordStart = 32 * 1024 * 1024 - original.length
      await handle.write(Buffer.from('\n'), 0, 1, recordStart - 1)
      await handle.write(original, 0, original.length, recordStart)
    } finally {
      await handle.close()
    }
    const result = await store.append(target, [mutation('second')])
    expect(result.records[0]?.rolloutOrdinal).toBe(1)
  })
})
