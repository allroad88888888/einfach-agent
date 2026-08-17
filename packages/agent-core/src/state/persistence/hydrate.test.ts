// 启动 hydrate：无 v1 时只恢复静态会话登记与用户 checkpoint 历史。

import { beforeEach, describe, expect, it } from 'vitest'

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
  itemsAtom,
  planAtom,
  runAtom,
} from '../sessionAtoms'
import { hydrate } from './hydrate'

const s1: SessionMeta = {
  id: 's1', title: 'A', settings: { vendor: 'deepseek', model: 'x' }, createdAt: 0, updatedAt: 100,
}
const s2: SessionMeta = {
  id: 's2', title: 'B', settings: { vendor: 'deepseek', model: 'x' }, createdAt: 0, updatedAt: 200,
}

beforeEach(() => {
  resetRootStore()
  resetSessionStores()
})

describe('hydrate', () => {
  it('retains static session fields needed by a later new run', async () => {
    const persisted: SessionMeta = { ...s1, loadedTools: ['shell_macos', 'read_file'] }

    await expect(hydrate({ sessions: { loadSessions: async () => [persisted] } })).resolves.toBe(true)

    expect(rootStore.getter(sessionsAtom).s1?.loadedTools).toEqual(['shell_macos', 'read_file'])
  })

  it('returns false for empty or unreadable static session storage', async () => {

    await expect(hydrate({ sessions: { loadSessions: async () => [] } })).resolves.toBe(false)
    await expect(hydrate({
      sessions: { loadSessions: async (): Promise<SessionMeta[]> => { throw new Error('boom') } },
    })).resolves.toBe(false)
    expect(rootStore.getter(sessionsAtom)).toEqual({})
    expect(rootStore.getter(activeSessionIdAtom)).toBe('')
  })
})
