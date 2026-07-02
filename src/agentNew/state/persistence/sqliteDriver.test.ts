// Ta-2 SQLite driver 单测（红→绿）。@tauri-apps/plugin-sql 在 jsdom 里无真实运行时，
// 故 mock 出一个「内存 fake DB」：按 SQL 子串分发到内存数组，验证 driver 的 SQL 构造 + 结果映射 +
// best-effort 降级（底层抛错时读退化为 []/undefined、写静默返回，绝不抛）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Checkpoint } from '../checkpoint.type'
import type { SessionMeta } from '../core.type'

// —— 内存 fake DB：按 SQL 子串识别 driver 发出的那几条语句 ——
interface CkRow {
  session_id: string
  turn_index: number
  label: string
  created_at: number
  items: string
}
function makeFakeDb() {
  const checkpoints: CkRow[] = []
  const sessions: { id: string; meta: string }[] = []
  let sessionsSnapshot: { id: string; meta: string }[] | null = null
  const ctrl = { failOnSessionId: null as string | null } // 注入：INSERT 该 session id 时抛错
  return {
    checkpoints,
    sessions,
    ctrl,
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('CREATE TABLE')) return { rowsAffected: 0 }
      // 事务语义（saveSessions 用）：BEGIN 快照 sessions、ROLLBACK 还原、COMMIT 丢弃快照。
      if (sql === 'BEGIN') {
        sessionsSnapshot = [...sessions]
        return { rowsAffected: 0 }
      }
      if (sql === 'COMMIT') {
        sessionsSnapshot = null
        return { rowsAffected: 0 }
      }
      if (sql === 'ROLLBACK') {
        if (sessionsSnapshot) {
          sessions.length = 0
          sessions.push(...sessionsSnapshot)
          sessionsSnapshot = null
        }
        return { rowsAffected: 0 }
      }
      if (sql.includes('INSERT OR REPLACE INTO checkpoints')) {
        const [session_id, turn_index, label, created_at, items] = params as [string, number, string, number, string]
        const i = checkpoints.findIndex((r) => r.session_id === session_id && r.turn_index === turn_index)
        const row = { session_id, turn_index, label, created_at, items }
        if (i >= 0) checkpoints[i] = row
        else checkpoints.push(row)
        return { rowsAffected: 1 }
      }
      if (sql.includes('DELETE FROM checkpoints') && sql.includes('turn_index >')) {
        const [session_id, turnIndex] = params as [string, number]
        for (let i = checkpoints.length - 1; i >= 0; i -= 1) {
          if (checkpoints[i].session_id === session_id && checkpoints[i].turn_index > turnIndex) checkpoints.splice(i, 1)
        }
        return { rowsAffected: 0 }
      }
      if (sql.includes('DELETE FROM checkpoints')) {
        const [session_id] = params as [string]
        for (let i = checkpoints.length - 1; i >= 0; i -= 1) {
          if (checkpoints[i].session_id === session_id) checkpoints.splice(i, 1)
        }
        return { rowsAffected: 0 }
      }
      if (sql.includes('DELETE FROM sessions')) {
        sessions.length = 0
        return { rowsAffected: 0 }
      }
      if (sql.includes('INSERT OR REPLACE INTO sessions')) {
        const [id, meta] = params as [string, string]
        if (ctrl.failOnSessionId === id) throw new Error('simulated INSERT failure')
        const i = sessions.findIndex((s) => s.id === id)
        if (i >= 0) sessions[i] = { id, meta }
        else sessions.push({ id, meta })
        return { rowsAffected: 1 }
      }
      return { rowsAffected: 0 }
    }),
    select: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM checkpoints') && sql.includes('AND turn_index = $2')) {
        const [session_id, turn_index] = params as [string, number]
        return checkpoints.filter((r) => r.session_id === session_id && r.turn_index === turn_index)
      }
      if (sql.includes('FROM checkpoints')) {
        const [session_id] = params as [string]
        return checkpoints
          .filter((r) => r.session_id === session_id)
          .sort((a, b) => a.turn_index - b.turn_index)
      }
      if (sql.includes('FROM sessions')) {
        return sessions.map((s) => ({ meta: s.meta }))
      }
      return []
    }),
  }
}

let fakeDb = makeFakeDb()
let loadImpl: () => Promise<unknown> = async () => fakeDb

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: (...args: unknown[]) => loadImpl() },
}))

import { createSqlitePersistence, __resetSqliteForTest } from './sqliteDriver'

beforeEach(() => {
  fakeDb = makeFakeDb()
  loadImpl = async () => fakeDb
  __resetSqliteForTest()
})
afterEach(() => {
  vi.clearAllMocks()
})

const ck = (turnIndex: number, items: Checkpoint['items'] = []): Checkpoint => ({
  turnIndex,
  label: `t${turnIndex}`,
  createdAt: turnIndex * 10,
  items,
})

describe('sqliteDriver — history', () => {
  it('saveCheckpoint → listCheckpoints（无 items）→ loadCheckpoint（含 items）round-trip', async () => {
    const { history } = createSqlitePersistence()
    await history.saveCheckpoint('s1', ck(0, [{ id: 'i0', createdAt: 1, item: { role: 'user', content: 'hi' } }]))
    await history.saveCheckpoint('s1', ck(1))

    const metas = await history.listCheckpoints('s1')
    expect(metas.map((m) => m.turnIndex)).toEqual([0, 1])
    expect(metas[0]).not.toHaveProperty('items') // 轻量 meta 不含 items

    const cp0 = await history.loadCheckpoint('s1', 0)
    expect(cp0?.items).toHaveLength(1)
    expect(cp0?.label).toBe('t0')
    expect(await history.loadCheckpoint('s1', 99)).toBeUndefined() // 越界
  })

  it('truncateAfter 删 turn_index > N；deleteSession 清空该会话', async () => {
    const { history } = createSqlitePersistence()
    for (let i = 0; i < 4; i += 1) await history.saveCheckpoint('s1', ck(i))
    await history.saveCheckpoint('s2', ck(0)) // 另一会话不受影响

    await history.truncateAfter('s1', 1)
    expect((await history.listCheckpoints('s1')).map((m) => m.turnIndex)).toEqual([0, 1])

    await history.deleteSession('s1')
    expect(await history.listCheckpoints('s1')).toEqual([])
    expect((await history.listCheckpoints('s2')).map((m) => m.turnIndex)).toEqual([0]) // s2 保留
  })

  it('best-effort：底层抛错 → 读退化为 []/undefined、写不抛（DK2）', async () => {
    loadImpl = async () => {
      throw new Error('no tauri runtime')
    }
    const { history } = createSqlitePersistence()
    await expect(history.saveCheckpoint('s1', ck(0))).resolves.toBeUndefined()
    await expect(history.truncateAfter('s1', 0)).resolves.toBeUndefined()
    await expect(history.deleteSession('s1')).resolves.toBeUndefined()
    expect(await history.listCheckpoints('s1')).toEqual([])
    expect(await history.loadCheckpoint('s1', 0)).toBeUndefined()
  })
})

describe('sqliteDriver — sessions', () => {
  const meta = (id: string): SessionMeta => ({
    id,
    title: id,
    settings: { vendor: 'deepseek', model: 'x' },
    createdAt: 0,
    updatedAt: 0,
  })

  it('saveSessions 覆盖式落盘 → loadSessions round-trip；再存更少 → 删掉的不残留', async () => {
    const { sessions } = createSqlitePersistence()
    await sessions.saveSessions([meta('a'), meta('b')])
    expect((await sessions.loadSessions()).map((s) => s.id).sort()).toEqual(['a', 'b'])

    await sessions.saveSessions([meta('a')]) // 覆盖：b 应消失
    expect((await sessions.loadSessions()).map((s) => s.id)).toEqual(['a'])
  })

  it('saveSessions 事务原子：INSERT 中途失败 → ROLLBACK，旧会话列表保住不被清空（codex P2）', async () => {
    const { sessions } = createSqlitePersistence()
    await sessions.saveSessions([meta('a'), meta('b')]) // 盘上先有 a、b
    fakeDb.ctrl.failOnSessionId = 'd' // 下次覆盖存到 d 时 INSERT 抛错
    await expect(sessions.saveSessions([meta('c'), meta('d')])).resolves.toBeUndefined() // 不抛
    // DELETE 已发生但整体 ROLLBACK → 仍是旧的 a、b（而非空或半个）。
    expect((await sessions.loadSessions()).map((s) => s.id).sort()).toEqual(['a', 'b'])
  })

  it('best-effort：底层抛错 → loadSessions 退化为 []、saveSessions 不抛', async () => {
    loadImpl = async () => {
      throw new Error('no tauri runtime')
    }
    const { sessions } = createSqlitePersistence()
    await expect(sessions.saveSessions([meta('a')])).resolves.toBeUndefined()
    expect(await sessions.loadSessions()).toEqual([])
  })
})
