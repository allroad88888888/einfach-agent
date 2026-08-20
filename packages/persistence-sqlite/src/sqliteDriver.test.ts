// Ta-2 SQLite driver 单测（红→绿）。jsdom 里没有任何真实 SQL 运行时，故注入一个「内存 fake DB」
// 当执行面：按 SQL 子串分发到内存数组，验证 driver 的 SQL 构造 + 结果映射 + best-effort 降级
// （底层抛错时读退化为 []/undefined、写静默返回，绝不抛）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionMeta } from '@einfach-agent/core/state/core.type'
import type { SqlExecutor } from '@einfach-agent/core/state/persistence'

// —— 内存 fake DB：按 SQL 子串识别 driver 发出的那几条语句 ——
function makeFakeDb() {
  const sessions: { id: string; meta: string }[] = []
  // 注入点：failSessionsInsert → sessions 的 upsert 抛错；failPragma → 任何 PRAGMA 抛错。
  const ctrl = { failSessionsInsert: false, failPragma: false }
  return {
    sessions,
    ctrl,
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('CREATE TABLE')) return { rowsAffected: 0 }
      if (sql.includes('DELETE FROM checkpoints') && sql.includes('turn_index >')) {
        return { rowsAffected: 0 }
      }
      if (sql.includes('DELETE FROM checkpoints')) {
        return { rowsAffected: 0 }
      }
      // legacy 死行清理：driver 只发 `DELETE FROM sessions WHERE id != '__all__'`（清非 blob 行）。
      if (sql.includes('DELETE FROM sessions')) {
        for (let i = sessions.length - 1; i >= 0; i -= 1) {
          if (sessions[i].id !== '__all__') sessions.splice(i, 1)
        }
        return { rowsAffected: 0 }
      }
      // sessions 单行 blob upsert：driver 用参数绑定传递固定 blob id 和 JSON。
      if (sql.includes('INSERT OR REPLACE INTO sessions')) {
        if (ctrl.failSessionsInsert) throw new Error('simulated sessions upsert failure')
        const [id, meta] = params as [string, string]
        const i = sessions.findIndex((s) => s.id === id)
        if (i >= 0) sessions[i] = { id, meta }
        else sessions.push({ id, meta })
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
      if (sql.includes('FROM sessions')) {
        return sessions.map((s) => ({ id: s.id, meta: s.meta }))
      }
      return []
    }),
  }
}

let fakeDb = makeFakeDb()
let loadImpl: () => Promise<unknown> = async () => fakeDb

import { createSqlitePersistence, __resetSqliteForTest } from './sqliteDriver'
import { configureSqlExecutor } from './sqliteShared'

// P1：本包不再 import 任何具体 SQL 上游包，fake DB 因此改从 configureSqlExecutor 这个注入槽进来，
// 而不是 vi.mock 掉那个上游模块。fake 本身与断言一个字都没动 —— 它的 execute/select 形状就是
// `SqlExecutor` 契约，之前能当 Database 使，现在能当执行面使。
beforeEach(() => {
  fakeDb = makeFakeDb()
  loadImpl = async () => fakeDb
  configureSqlExecutor(async () => (await loadImpl()) as SqlExecutor)
  __resetSqliteForTest()
})
afterEach(() => {
  vi.clearAllMocks()
})

const meta = (id: string): SessionMeta => ({
  id,
  title: id,
  settings: { vendor: 'deepseek', model: 'x' },
  createdAt: 0,
  updatedAt: 0,
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
    expect(inserts[0][1]).toMatchObject(['__all__', expect.any(String)])
    const blob = JSON.parse((inserts[0][1] as unknown[])[1] as string) as SessionMeta[]
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
      throw new Error('no sqlite runtime')
    }
    const { sessions } = createSqlitePersistence()
    await expect(sessions.saveSessions([meta('a')])).resolves.toBeUndefined()
    expect(await sessions.loadSessions()).toEqual([])
  })

  // P1：没登记执行面 = 装配错误。失败形状必须与上一条（宿主没有 SQL 运行时）逐字一致 ——
  // 都是 getDb() 那个 promise reject，各 driver 的既有降级路径因此一行都不用改。
  it('未登记执行面 → 与「底层抛错」同一条降级路径，且不返回任何兜底实现', async () => {
    configureSqlExecutor(undefined)
    const { sessions } = createSqlitePersistence()
    await expect(sessions.saveSessions([meta('a')])).resolves.toBeUndefined()
    expect(await sessions.loadSessions()).toEqual([])
    expect(fakeDb.execute).not.toHaveBeenCalled()
    expect(fakeDb.select).not.toHaveBeenCalled()
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

describe('sqliteDriver — 轮级 undo 退场后的架构', () => {
  it('不再建 checkpoints 表，只建 recovery_snapshots，并丢弃遗留表', async () => {
    const { sessions } = createSqlitePersistence()
    await sessions.loadSessions()

    const statements = fakeDb.execute.mock.calls.map(([sql]) => String(sql))
    expect(statements.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS checkpoints'))).toBe(false)
    expect(statements.some((sql) => sql.startsWith('ALTER TABLE checkpoints'))).toBe(false)
    expect(statements).toContain('DROP TABLE IF EXISTS checkpoints')
    expect(statements.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS recovery_snapshots'))).toBe(true)
  })
})
