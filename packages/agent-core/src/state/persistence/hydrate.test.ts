// 启动 hydrate：无 v1 时只恢复静态会话登记与用户 checkpoint 历史。

import { beforeEach, describe, expect, it } from 'vitest'

import type { Checkpoint } from '../checkpoint.type'
import type { SessionMeta } from '../core.type'
import {
  rootStore,
  workspacesAtom,
  activeWorkspaceIdAtom,
  sessionsAtom,
  activeSessionIdAtom,
  resetRootStore,
} from '../rootStore'
import { getSessionStore, resetSessionStores } from '../sessionStore'
import {
  checkpointsAtom,
  itemsAtom,
  planAtom,
  runAtom,
} from '../sessionAtoms'
import { createMemoryHistoryDriver } from './memoryHistoryDriver'
import { hydrate } from './hydrate'

const s1: SessionMeta = {
  id: 's1', title: 'A', settings: { vendor: 'deepseek', model: 'x' }, createdAt: 0, updatedAt: 100,
}
const s2: SessionMeta = {
  id: 's2', title: 'B', settings: { vendor: 'deepseek', model: 'x' }, createdAt: 0, updatedAt: 200,
}

function cp(turnIndex: number, content: string): Checkpoint {
  return {
    turnIndex,
    label: `t${turnIndex}`,
    createdAt: turnIndex,
    items: [{ id: `${content}-${turnIndex}`, createdAt: turnIndex, item: { role: 'user', content } }],
  }
}

beforeEach(() => {
  resetRootStore()
  resetSessionStores()
})

describe('hydrate', () => {
  it('keeps non-candidate checkpoint history static when no v1 record exists', async () => {
    const history = createMemoryHistoryDriver()
    await history.saveCheckpoint('s1', cp(0, 's1a'))
    await history.saveCheckpoint('s1', cp(1, 's1b'))
    await history.saveCheckpoint('s2', cp(0, 's2a'))
    await history.saveCheckpoint('s2', cp(1, 's2b'))
    await history.saveCheckpoint('s2', cp(2, 's2c'))

    await expect(hydrate({ sessions: { loadSessions: async () => [s1, s2] }, history })).resolves.toBe(true)

    const restored = rootStore.getter(sessionsAtom)
    expect(restored.s1).toMatchObject(s1)
    expect(restored.s2).toMatchObject(s2)
    expect(restored.s1.workspaceId).toBe(restored.s2.workspaceId)
    expect(rootStore.getter(workspacesAtom)[restored.s1.workspaceId!].name).toBe('默认工作区')
    expect(rootStore.getter(activeWorkspaceIdAtom)).toBe(restored.s2.workspaceId)
    expect(rootStore.getter(activeSessionIdAtom)).toBe('s2')

    const store1 = getSessionStore('s1').store
    expect(store1.getter(checkpointsAtom)).toEqual([cp(0, 's1a'), cp(1, 's1b')])
    expect(store1.getter(itemsAtom)).toEqual([])
    expect(store1.getter(planAtom)).toBeUndefined()
    expect(store1.getter(runAtom)).toBeUndefined()
  })

  it('retains static session fields needed by a later new run', async () => {
    const history = createMemoryHistoryDriver()
    const persisted: SessionMeta = { ...s1, loadedTools: ['shell_macos', 'read_file'] }

    await expect(hydrate({ sessions: { loadSessions: async () => [persisted] }, history })).resolves.toBe(true)

    expect(rootStore.getter(sessionsAtom).s1?.loadedTools).toEqual(['shell_macos', 'read_file'])
  })

  it('retains legacy checkpoint history while stripping its recovery payload', async () => {
    const history = createMemoryHistoryDriver()
    await history.saveCheckpoint('s1', {
      ...cp(0, 'legacy history'),
      recovery: { run: { runId: 'discarded', status: 'running' } },
    } as Checkpoint)

    await expect(hydrate({ sessions: { loadSessions: async () => [s1] }, history })).resolves.toBe(true)

    const restored = getSessionStore('s1').store.getter(checkpointsAtom)
    expect(restored).toEqual([cp(0, 'legacy history')])
    expect(restored[0]).not.toHaveProperty('recovery')
    expect(getSessionStore('s1').store.getter(runAtom)).toBeUndefined()
  })

  it('returns false for empty or unreadable static session storage', async () => {
    const history = createMemoryHistoryDriver()

    await expect(hydrate({ sessions: { loadSessions: async () => [] }, history })).resolves.toBe(false)
    await expect(hydrate({
      sessions: { loadSessions: async (): Promise<SessionMeta[]> => { throw new Error('boom') } }, history,
    })).resolves.toBe(false)
    expect(rootStore.getter(sessionsAtom)).toEqual({})
    expect(rootStore.getter(activeSessionIdAtom)).toBe('')
  })
})
