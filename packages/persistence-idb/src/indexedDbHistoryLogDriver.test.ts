import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'

import type { PersistedHistoryLog } from '@web-agent/core/state/persistence'
import { createIndexedDbHistoryLogDriver } from './indexedDbHistoryLogDriver'
import { HISTORY_LOG_STORE_NAME, openIndexedDbHistoryDatabase } from './indexedDbDatabase'

function log(generation: number, entryCount = 1): PersistedHistoryLog {
  return {
    generation,
    entries: Array.from({ length: entryCount }, (_, index) => ({
      txId: `tx-${index + 1}`,
      label: 't1',
      ops: [{ key: 'composerDraft', before: '', after: `草稿${index}` }],
    })),
    cursor: entryCount,
  }
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

describe('IndexedDB 事务日志 driver', () => {
  it('往返保住条目与游标', async () => {
    const driver = createIndexedDbHistoryLogDriver()
    await driver.save('s1', log(7, 3))

    const loaded = await driver.load('s1')
    expect(loaded?.generation).toBe(7)
    expect(loaded?.cursor).toBe(3)
    expect(loaded?.entries).toHaveLength(3)
    expect(loaded?.entries[0]?.ops[0]).toMatchObject({ key: 'composerDraft', after: '草稿0' })
  })

  it('同一 session 整份覆盖，不追加', async () => {
    const driver = createIndexedDbHistoryLogDriver()
    await driver.save('s1', log(1, 5))
    await driver.save('s1', log(2, 2))

    const loaded = await driver.load('s1')
    expect(loaded?.generation).toBe(2)
    expect(loaded?.entries).toHaveLength(2)
  })

  it('没有记录时返回 undefined', async () => {
    expect(await createIndexedDbHistoryLogDriver().load('missing')).toBeUndefined()
  })

  it('会话之间互不影响', async () => {
    const driver = createIndexedDbHistoryLogDriver()
    await driver.save('s1', log(1, 1))
    await driver.save('s2', log(9, 4))

    expect((await driver.load('s1'))?.generation).toBe(1)
    expect((await driver.load('s2'))?.entries).toHaveLength(4)
  })

  it('删除后读不到', async () => {
    const driver = createIndexedDbHistoryLogDriver()
    await driver.save('s1', log(1))
    await driver.deleteSession('s1')

    expect(await driver.load('s1')).toBeUndefined()
  })

  it('删除一个不存在的会话不抛', async () => {
    await expect(createIndexedDbHistoryLogDriver().deleteSession('missing')).resolves.toBeUndefined()
  })

  it('坏记录降级为「没有日志」而不是抛', async () => {
    // 日志不是真相：读不出来就当没有，撤销不可用好过把启动拖垮。
    const db = await openIndexedDbHistoryDatabase('web-agent-history')
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(HISTORY_LOG_STORE_NAME, 'readwrite')
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.objectStore(HISTORY_LOG_STORE_NAME).put({ sessionId: 's1', generation: 'nope', entries: 'x' })
    })
    db.close()

    expect(await createIndexedDbHistoryLogDriver().load('s1')).toBeUndefined()
  })

  it('空 sessionId 拒绝', async () => {
    await expect(createIndexedDbHistoryLogDriver().load('')).rejects.toThrow(/sessionId/)
  })
})
