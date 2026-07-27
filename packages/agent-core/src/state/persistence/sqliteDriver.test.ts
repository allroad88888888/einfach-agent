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
  plan: string | null
  recovery: string | null
}
function makeFakeDb() {
  const checkpoints: CkRow[] = []
  const sessions: { id: string; meta: string }[] = []
  // 注入点：failSessionsInsert → sessions 的 upsert 抛错；failPragma → 任何 PRAGMA 抛错。
  const ctrl = { failSessionsInsert: false, failPragma: false }
  return {
    checkpoints,
    sessions,
    ctrl,
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('CREATE TABLE')) return { rowsAffected: 0 }
      if (sql.includes('INSERT OR REPLACE INTO checkpoints')) {
        const [session_id, turn_index, label, created_at, items, plan, recovery] = params as [
          string,
          number,
          string,
          number,
          string,
          string | null,
          string | null,
        ]
        const i = checkpoints.findIndex((r) => r.session_id === session_id && r.turn_index === turn_index)
        const row = { session_id, turn_index, label, created_at, items, plan, recovery }
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
      // legacy 死行清理：driver 只发 `DELETE FROM sessions WHERE id != '__all__'`（清非 blob 行）。
      if (sql.includes('DELETE FROM sessions')) {
        for (let i = sessions.length - 1; i >= 0; i -= 1) {
          if (sessions[i].id !== '__all__') sessions.splice(i, 1)
        }
        return { rowsAffected: 0 }
      }
      // sessions 单行 blob upsert：driver 固定写 id='__all__'（params 只带 meta 一个）。
      if (sql.includes('INSERT OR REPLACE INTO sessions')) {
        if (ctrl.failSessionsInsert) throw new Error('simulated sessions upsert failure')
        const [meta] = params as [string]
        const i = sessions.findIndex((s) => s.id === '__all__')
        if (i >= 0) sessions[i] = { id: '__all__', meta }
        else sessions.push({ id: '__all__', meta })
        return { rowsAffected: 1 }
      }
      return { rowsAffected: 0 }
    }),
    select: vi.fn(async (sql: string, params: unknown[] = []) => {
      // PRAGMA 连接调优（getDb 里发）：默认返回一行；注入 failPragma 时抛错，验证降级不阻塞建表。
      if (sql.startsWith('PRAGMA')) {
        if (ctrl.failPragma) throw new Error('simulated PRAGMA failure')
        return [{ ok: 1 }]
      }
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
        return sessions.map((s) => ({ id: s.id, meta: s.meta }))
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

const meta = (id: string): SessionMeta => ({
  id,
  title: id,
  settings: { vendor: 'deepseek', model: 'x' },
  createdAt: 0,
  updatedAt: 0,
})

describe('sqliteDriver — history', () => {
  it('saveCheckpoint → listCheckpoints（无 items）→ loadCheckpoint（含 items）round-trip', async () => {
    const { history } = createSqlitePersistence()
    const checkpoint = ck(0, [{ id: 'i0', createdAt: 1, item: { role: 'user', content: 'hi' } }])
    checkpoint.plan = {
      id: 'p1',
      title: '计划',
      objective: '验证计划快照',
      status: 'active',
      revision: 1,
      requiresApproval: false,
      createdAt: 1,
      updatedAt: 1,
      stages: [],
    }
    checkpoint.recovery = {
      run: {
        runId: 'running-before-restart',
        turnId: 'i0',
        status: 'running',
      },
      queuedUserMessages: [{
        id: 'queued-1',
        createdAt: 2,
        content: '补充要求',
        targetRunId: 'running-before-restart',
      }],
    }
    await history.saveCheckpoint('s1', checkpoint)
    await history.saveCheckpoint('s1', ck(1))

    const metas = await history.listCheckpoints('s1')
    expect(metas.map((m) => m.turnIndex)).toEqual([0, 1])
    expect(metas[0]).not.toHaveProperty('items') // 轻量 meta 不含 items

    const cp0 = await history.loadCheckpoint('s1', 0)
    expect(cp0?.items).toHaveLength(1)
    expect(cp0?.label).toBe('t0')
    expect(cp0?.plan).toEqual(checkpoint.plan)
    expect(cp0?.recovery).toEqual(checkpoint.recovery)
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
  it('saveSessions 单行 blob 落盘 → loadSessions round-trip；再存更少 → 删掉的不残留', async () => {
    const { sessions } = createSqlitePersistence()
    await sessions.saveSessions([{ ...meta('a'), loadedTools: ['shell_macos', 'read_file'] }, meta('b')])
    const loaded = await sessions.loadSessions()
    expect(loaded.map((s) => s.id).sort()).toEqual(['a', 'b'])
    expect(loaded.find((session) => session.id === 'a')?.loadedTools)
      .toEqual(['shell_macos', 'read_file'])

    await sessions.saveSessions([meta('a')]) // 覆盖：b 应消失
    expect((await sessions.loadSessions()).map((s) => s.id)).toEqual(['a'])
    // 落盘只用一行（固定 '__all__' 哨兵），而非每会话一行。
    expect(fakeDb.sessions.map((r) => r.id)).toEqual(['__all__'])
  })

  it('回归钉死假事务：saveSessions 只发单条 INSERT OR REPLACE（__all__ 整包 JSON），绝不发 BEGIN/COMMIT/ROLLBACK', async () => {
    const { sessions } = createSqlitePersistence()
    await sessions.saveSessions([meta('a'), meta('b')])
    const stmts = fakeDb.execute.mock.calls.map((c) => String(c[0]))
    // 绝不再出现跨语句事务控制（连接池上事务不成立、会遗留写锁 —— 本轮修复的根因）。
    expect(stmts.some((s) => /\bBEGIN\b/.test(s))).toBe(false)
    expect(stmts.some((s) => /\bCOMMIT\b/.test(s))).toBe(false)
    expect(stmts.some((s) => /\bROLLBACK\b/.test(s))).toBe(false)
    // 单条 upsert，写入固定 '__all__' 行 + 整个数组的 JSON。
    const inserts = fakeDb.execute.mock.calls.filter((c) => String(c[0]).includes('INSERT OR REPLACE INTO sessions'))
    expect(inserts).toHaveLength(1)
    expect(String(inserts[0][0])).toContain("'__all__'")
    const blob = JSON.parse((inserts[0][1] as unknown[])[0] as string) as SessionMeta[]
    expect(blob.map((s) => s.id).sort()).toEqual(['a', 'b'])
  })

  it('loadSessions 读 __all__ blob 正确解析（单行含整个数组）', async () => {
    // 直接塞一行新格式 blob，验证读路径优先解析它。
    fakeDb.sessions.push({ id: '__all__', meta: JSON.stringify([meta('a'), meta('b'), meta('c')]) })
    const { sessions } = createSqlitePersistence()
    expect((await sessions.loadSessions()).map((s) => s.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('兼容读旧的逐行格式（无 __all__ → 逐行 parse）；下次 save 迁移为单行 blob 并清 legacy 死行', async () => {
    // 旧库：每行一个 meta，无 '__all__' 哨兵行。
    fakeDb.sessions.push({ id: 'a', meta: JSON.stringify(meta('a')) })
    fakeDb.sessions.push({ id: 'b', meta: JSON.stringify(meta('b')) })
    const { sessions } = createSqlitePersistence()
    // 首次读旧库仍能读到全部（并在内部标记 legacy 待清理）。
    expect((await sessions.loadSessions()).map((s) => s.id).sort()).toEqual(['a', 'b'])

    // 下次 save：写 '__all__' 单行 + 清掉 legacy 逐行死行 → 只剩 '__all__'。
    await sessions.saveSessions([meta('a'), meta('b')])
    expect(fakeDb.sessions.map((r) => r.id)).toEqual(['__all__'])
    expect((await sessions.loadSessions()).map((s) => s.id).sort()).toEqual(['a', 'b'])
  })

  it('saveSessions 单条 upsert 失败 → 旧的 __all__ blob 保住（无半写、无残留事务锁）', async () => {
    const { sessions } = createSqlitePersistence()
    await sessions.saveSessions([meta('a'), meta('b')]) // 盘上 __all__ = [a, b]
    fakeDb.ctrl.failSessionsInsert = true // 下次单条 upsert 抛错
    await expect(sessions.saveSessions([meta('c'), meta('d')])).resolves.toBeUndefined() // 不抛
    // 单语句失败即整体无效：旧 blob 原封不动（不像假事务那样把列表清空/半写）。
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

// —— PRAGMA 连接调优：init 时执行 + 失败降级不阻塞 ——
describe('sqliteDriver — PRAGMA 连接调优', () => {
  it('init 时执行 PRAGMA：journal_mode=WAL / busy_timeout=5000 / synchronous=NORMAL 各一次', async () => {
    const { sessions } = createSqlitePersistence()
    await sessions.loadSessions() // 触发 getDb → 发 PRAGMA
    const pragmas = fakeDb.select.mock.calls.map((c) => String(c[0])).filter((s) => s.startsWith('PRAGMA'))
    expect(pragmas.filter((s) => s.includes('journal_mode=WAL'))).toHaveLength(1)
    expect(pragmas.filter((s) => s.includes('busy_timeout=5000'))).toHaveLength(1)
    expect(pragmas.filter((s) => s.includes('synchronous=NORMAL'))).toHaveLength(1)
  })

  it('PRAGMA 失败不阻塞：底层对 PRAGMA 抛错，仍能建表 + 正常读写', async () => {
    fakeDb.ctrl.failPragma = true
    const { sessions } = createSqlitePersistence()
    await expect(sessions.saveSessions([meta('a')])).resolves.toBeUndefined()
    expect((await sessions.loadSessions()).map((s) => s.id)).toEqual(['a'])
  })
})
