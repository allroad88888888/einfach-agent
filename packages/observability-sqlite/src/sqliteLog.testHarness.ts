// 本包测试共用的替身执行面。
// ---------------------------------------------------------------------------
// 四份测试（transport / schema / driver / reader）都要一个「能记下每条 SQL 与参数」的
// `SqlExecutor`。各写各的会让「PRAGMA 走 select 还是 execute」这类判据在四处各有一份口径，
// 而那正是本卡要钉住的东西。
//
// 类型上做成 `SqlExecutor & { …两个 mock… }` 的交叉并在工厂里断言一次：`SqlExecutor.select` 是
// **泛型**方法（`select<Rows>(…): Promise<Rows>`），而 `vi.fn` 造不出泛型签名。不做这层断言的话，
// 每个 `configureTraceSqlExecutor(async () => db)` 调用点都要各自 `as SqlExecutor` 一次。

import { vi } from 'vitest'
import type { SqlExecuteResult, SqlExecutor } from '@einfach-agent/core/state/persistence'

export type FakeSqlExecutor = SqlExecutor & {
  execute: ReturnType<typeof vi.fn<(sql: string, params?: unknown[]) => Promise<SqlExecuteResult>>>
  select: ReturnType<typeof vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>>
}

/** 一个什么都记下来、什么都成功的执行面。 */
export function makeFakeExecutor(): FakeSqlExecutor {
  const execute = vi.fn(async (_sql: string, _params?: unknown[]): Promise<SqlExecuteResult> => (
    { rowsAffected: 0 }
  ))
  const select = vi.fn(async (_sql: string, _params?: unknown[]): Promise<unknown> => [])
  return { execute, select } as unknown as FakeSqlExecutor
}

/** 某个执行面上跑过的全部 `execute` 语句，按调用顺序。 */
export function executedSql(db: FakeSqlExecutor): string[] {
  return db.execute.mock.calls.map(([sql]) => String(sql))
}

/** 某个执行面上跑过的全部 `select` 语句，按调用顺序。 */
export function selectedSql(db: FakeSqlExecutor): string[] {
  return db.select.mock.calls.map(([sql]) => String(sql))
}

/** 第一条含 `needle` 的 `execute` 调用在整个 execute 序列里的下标；找不到回 -1。 */
export function indexOfExecuted(db: FakeSqlExecutor, needle: string): number {
  return executedSql(db).findIndex((sql) => sql.includes(needle))
}
