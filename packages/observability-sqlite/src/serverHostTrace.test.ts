// 「trace viewer 在 server 宿主下能读到 span」的机器判据（P4）
// ---------------------------------------------------------------------------
// server 宿主下 trace 的通路是：driver/reader → 注入的 `SqlExecutor` → `POST /api/invoke/
// sqlite_execute|sqlite_select` → host-node 的 sqlite 域 → node:sqlite。本文件把这条链上
// **除 HTTP 那一跳以外**的全部环节接成真的：用 host-node 交给进程内装配的那个执行面
// （`createNodeSqlExecutorLoader(options, 'observability')`，与 HTTP 路由共用同一份
// connections/statementShape/nodeSqliteExecutor 实现），在一个临时库文件上写 span、再读回来。
//
// HTTP 那一跳由 `apps/server/src/sqlRouteContract.test.ts` 覆盖（端点、认证、多语句拦截、
// PRAGMA 走 select），本文件不重复；两者合起来才是整条链。
//
// ═══ 为什么这条测试不能用替身执行面代替 ═══
// 替身什么 SQL 都收。而 server 宿主那条路上有一道 host-node 独有的闸门：执行前会扫每条 SQL
// （`statementShape.ts`），多语句、事务控制语句、`$N` 个数与 params 对不上，一律当场拒绝。
// 本包的建表、六条 ALTER、六条索引、那句 `$1` 出现两次的恢复 UPDATE，以及两条 INSERT，必须
// 条条过得了这道闸——当年桌面壳（Tauri）的 sqlx 没有这道闸，过不了的症状就是「桌面上 trace 好好
// 的，换 server 宿主一条 span 都建不出来」；桌面端已随 T1 删除，但这道闸依旧是唯一的真相来源，
// 替身测不出闸门拒收，只有真执行面才能。
//
// ═══ 跨包 import 的说明 ═══
// 本文件是**测试**，`@einfach-agent/host-node` 只在测试期出现（check-boundaries 的
// `testFilePattern` 与本包 `tsconfig.build.json` 的 `exclude` 都跳过 `.test.ts`）。
// 生产代码这边一个字都不认识 host-node：执行面是装配层注入进来的。

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeSqliteConnections, createNodeSqlExecutorLoader, resolveSqliteDatabasePath } from '@einfach-agent/host-node'
import { __resetSqliteLogForTest, configureTraceSqlExecutor } from './sqliteLogTransport'
import { createSqliteLogDriver } from './sqliteLogDriver'
import { createSqliteLogReader } from './sqliteLogReader'
import type { TraceSpan } from '@einfach-agent/core/observability'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'web-agent-trace-'))
  configureTraceSqlExecutor(createNodeSqlExecutorLoader({ homeDir: home }, 'observability'))
  __resetSqliteLogForTest()
})

afterEach(async () => {
  configureTraceSqlExecutor(undefined)
  __resetSqliteLogForTest()
  // 句柄不关的话临时目录在 Windows 上删不掉，`-wal` / `-shm` 也会留着。
  await closeSqliteConnections()
  await rm(home, { recursive: true, force: true })
})

const SPAN: TraceSpan = {
  id: 'span-1',
  traceId: 'trace-1',
  name: 'agent.run',
  kind: 'agent',
  status: 'ok',
  startedAt: 100,
  endedAt: 140,
  durationMs: 40,
  attrs: { sessionId: 's-1', runId: 'r-1', model: 'x' },
}

describe('server 宿主的 trace 通路', () => {
  it('driver 写下的 span 与 event，reader 原样读得回来', async () => {
    const driver = createSqliteLogDriver()
    await driver.writeSpan(SPAN)
    await driver.writeEvent({
      id: 'evt-1',
      traceId: 'trace-1',
      spanId: 'span-1',
      name: 'tool.result',
      timestamp: 120,
      attrs: { sessionId: 's-1' },
    })

    const snapshot = await createSqliteLogReader().readAll()

    expect(snapshot.source).toBe('sqlite')
    expect(snapshot.spans).toEqual([{ ...SPAN, parentSpanId: undefined, error: undefined }])
    expect(snapshot.events).toEqual([
      {
        id: 'evt-1',
        traceId: 'trace-1',
        spanId: 'span-1',
        name: 'tool.result',
        timestamp: 120,
        attrs: { sessionId: 's-1' },
      },
    ])
  })

  // driver 的 catch 会把**任何**失败吞掉，包括「建表语句被闸门拒了」。所以光断言 writeSpan
  // resolve 证明不了什么，必须回头看那一行到底在不在库里——上面那条用例读回来的正是它。
  // 这一条另外钉住闸门本身没被绕过：多语句在同一条执行面上仍然是硬失败。
  it('同一条执行面仍然拒绝多语句（半份数据不许落盘）', async () => {
    await createSqliteLogDriver().writeSpan(SPAN)
    const loader = createNodeSqlExecutorLoader({ homeDir: home }, 'observability')
    const db = await loader()

    await expect(
      db.execute('CREATE TABLE a (id TEXT); CREATE TABLE b (id TEXT)'),
    ).rejects.toThrow(/一条 SQL 语句/)
    await expect(db.select("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'a'"))
      .resolves.toEqual([])
  })

  // 浏览器（server 宿主）与 CLI 共用同一份库文件（判据同 persistenceDrivers.ts）：两条路径要看到
  // 同一份 trace 数据，落地点就得是同一个。（当年桌面壳也遵循这条——把 trace 与会话写进同一个库
  // 文件；桌面端已随 T1 删除，但「两条路径共享一份库文件」这条判据延续到了 server 与 CLI 之间。）
  it('落在 server／CLI 共用的那个库文件上', async () => {
    await createSqliteLogDriver().writeSpan(SPAN)
    const db = await createNodeSqlExecutorLoader({ homeDir: home }, 'observability')()

    await expect(
      db.select("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'trace_spans'"),
    ).resolves.toEqual([{ name: 'trace_spans' }])
    expect(resolveSqliteDatabasePath({ homeDir: home })).toContain('web-agent.db')
  })

  // 上次进程被强退留下的 running 行，本进程第一条新 span 写入之前会被收掉——这条在真库上跑，
  // 因为它是整段建表里唯一带参数、且 `$1` 出现两次的语句（位置绑定在这里会当场 SQLITE_RANGE）。
  it('遗留的 running span 被收为 cancelled', async () => {
    const stale: TraceSpan = { ...SPAN, id: 'span-stale', status: 'running', endedAt: undefined, durationMs: undefined }
    await createSqliteLogDriver().writeSpan(stale)

    // 模拟「换了一个进程」：清掉建表 memo，下一次写入会重新跑一遍带起来的那几步。
    __resetSqliteLogForTest()
    await createSqliteLogDriver().writeSpan({ ...SPAN, id: 'span-fresh' })

    const snapshot = await createSqliteLogReader().readAll()
    const recovered = snapshot.spans.find((span) => span.id === 'span-stale')
    expect(recovered?.status).toBe('cancelled')
    expect(recovered?.error).toBe('Recovered after application restart')
    expect(snapshot.spans.find((span) => span.id === 'span-fresh')?.status).toBe('ok')
  })
})
