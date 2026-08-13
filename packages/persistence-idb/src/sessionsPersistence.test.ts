// D-2 · 会话列表（SessionMeta）持久化的单测（测试先行：红 → 绿）。
// ---------------------------------------------------------------------------
// jsdom 默认没有原生 IndexedDB —— 顶部 `import 'fake-indexeddb/auto'` 把 indexedDB /
//   IDBKeyRange 等注入全局（项目已装 fake-indexeddb@6，见 package.json devDependencies），
//   并在 beforeEach 用 `new IDBFactory()` 重置，保证各用例互相隔离（对齐 indexedDbDriver.test.ts）。
// 覆盖 §4 D-2 / §1 DK1：saveSessions→loadSessions round-trip；覆盖式（save 后完全等于传入列表）；
//   空库 → []。全部方法均为 async（await）。

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'

import type { SessionMeta, WorkspaceMeta } from '@web-agent/core/state/core.type'
import { createIndexedDbSessionsPersistence } from './sessionsPersistence'

// SessionMeta 样例：两个会话，settings 用最简 deepseek 形状。
const a: SessionMeta = {
  id: 's1',
  title: 't',
  settings: { vendor: 'deepseek', model: 'x' },
  createdAt: 0,
  updatedAt: 0,
  loadedTools: ['shell_macos', 'read_file'],
}
const b: SessionMeta = {
  id: 's2',
  title: 't2',
  settings: { vendor: 'deepseek', model: 'x' },
  createdAt: 0,
  updatedAt: 0,
}
const workspace: WorkspaceMeta = {
  id: 'w1',
  name: 'project',
  rootPath: '/workspace/project',
  createdAt: 0,
  updatedAt: 1,
}

describe('createIndexedDbSessionsPersistence', () => {
  // 每个用例给一个干净的 IndexedDB 实例（丢掉上一个用例落盘的所有库）。
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
  })

  it('saveSessions([a,b]) → loadSessions() 返回 2 项', async () => {
    const p = createIndexedDbSessionsPersistence()
    await p.saveSessions([a, b])

    const loaded = await p.loadSessions()
    expect(loaded).toHaveLength(2)
    expect(loaded).toContainEqual(a)
    expect(loaded).toContainEqual(b)
  })

  it('覆盖式：saveSessions([a]) 后 loadSessions() 只剩 1（clear 再 put）', async () => {
    const p = createIndexedDbSessionsPersistence()
    await p.saveSessions([a, b])
    await p.saveSessions([a])

    const loaded = await p.loadSessions()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toEqual(a)
  })

  it('空库 loadSessions() → []', async () => {
    const p = createIndexedDbSessionsPersistence()
    expect(await p.loadSessions()).toEqual([])
  })

  it('工作区可独立覆盖式持久化，不与会话记录混在一起', async () => {
    const p = createIndexedDbSessionsPersistence()
    await p.saveWorkspaces([workspace])
    expect(await p.loadWorkspaces()).toEqual([workspace])

    await p.saveWorkspaces([])
    expect(await p.loadWorkspaces()).toEqual([])
  })
})
