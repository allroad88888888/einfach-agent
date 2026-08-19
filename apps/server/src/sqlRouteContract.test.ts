// SQL 端点的契约：它是哪条路由、它在不在认证之后、有没有第二扇门。
// ---------------------------------------------------------------------------
// ═══ 为什么本卡（P3）没有新建 `sqlRoute.ts` ═══
// P3 卡面的改动面写着「新建 `apps/server/src/sqlRoute*`（端点）」。落地时**没有新建端点**，
// 因为它已经存在，且是上一张卡刻意做成这样的：
//   · P2 把 Node 侧的 SQL 执行定成两条**命令**——`sqlite_execute` / `sqlite_select`
//     （`packages/host-node/src/commandNames.ts:95`）；
//   · 并把 sqlite 域展开进了总路由表（`createNodeHostInvoke.ts` 里
//     `...createSqliteRoutes(options)` 那一行）；
//   · P2 的状态段原话：「必须回来登记进 `NODE_HOST_COMMANDS_BY_DOMAIN`，否则分发层会以
//     `unknown-command` 拒绝它」——**登记进命令全集的全部目的，就是让 S3 那张统一路由表认得它**。
// 于是 `POST /api/invoke/sqlite_execute` 从 P2 合入的那一刻起就是可用的 SQL 端点。
//
// 再开一条 `/api/sql` 只会得到**第二扇通往同一批 handler 的门**：第二处要正确接在
// `authGuard` 之后、第二套 body 上限与失败信封、第二处会随命令表漂移——而它换不来任何
// 现有这条路做不到的事（port 是单条语句粒度，没有批量/事务可言，见 core 的 sqlTransport.ts）。
// 判据「SQL 端点必须落在同一条认证收口后面」因此不是靠自觉，而是结构性的：**这条路上没有
// 第二扇门**。本文件就是那句话的回归网。
//
// ═══ 本文件为什么是「只有测试、没有同名源码」 ═══
// 它记录的是一个**不新建模块**的决定。为它造一个没有任何 import 方的 `sqlRoute.ts`（只放两个
// 常量或一句注释）才是噪音：仓库里会多出一份看起来是端点、实际上谁也不路由的东西。
// 名字仍用 `sqlRoute*` 前缀，好让照卡面来找的人第一眼就找到这份裁决。
//
// ═══ 顺带记一条与本卡无关但影响这条路的事实（不在本卡改动面，未改） ═══
// `invokeRoute.ts` 只把 `NodeHostCommandError` 映射成 JSON 失败信封，**其余异常一律重抛**，
// 由 `requestRouter.ts` 收成 `text/plain` 的 500「服务端内部错误。」。于是 host-node 各域自己抛的
// **业务性**失败（SQL 语法错、多语句被拦、run index 游标非法……）跨 HTTP 之后全部退化成一句
// 没有病因的 500，而 `serverInvoke.ts` 那头解析不出失败信封，只能给出「本地服务返回了非预期的
// 错误响应（HTTP 500）」。同时它们还会被当作「预期外异常」写进 server 的 stderr。
// 这是整条 invoke 路由的性质（30 条命令都一样），不是 sqlite 特有，所以本卡不在这里单独修
// ——只给 SQL 改一套错误约定会造出第二种线上形状。下面「多语句」那条用例因此只钉真正的不变量
// （**半份数据不许落盘**），不钉状态码。

import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeSqliteConnections, resolveSqliteDatabasePath } from '@einfach-agent/host-node'
import { sendInvokeRequest } from './invokeRoute.testHarness'
import { startTestServer, type TestServerHandle } from './testServer.testHarness'

const TOKEN = 'sql-route-token-0123456789'
const EXECUTE_PATH = '/api/invoke/sqlite_execute'
const SELECT_PATH = '/api/invoke/sqlite_select'

let home: string
let server: TestServerHandle | undefined

/** 本次启动会打开哪个库文件——和服务端用的是同一个解析函数，不另抄一份路径拼接。 */
function databasePath(): string {
  return resolveSqliteDatabasePath({ homeDir: home })
}

async function start(): Promise<number> {
  server = await startTestServer({ token: TOKEN, homeDir: home, version: '0.0.0-test' })
  return server.port
}

interface SqlBody {
  readonly connection: string
  readonly sql: string
  readonly params?: unknown[]
}

async function postSql(
  port: number,
  path: string,
  body: SqlBody,
  headers: Record<string, string> = {},
) {
  return sendInvokeRequest(port, 'POST', path, JSON.stringify(body), {
    'content-type': 'application/json',
    ...headers,
  })
}

function authorized(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}` }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'web-agent-sql-route-'))
})

afterEach(async () => {
  await server?.close()
  server = undefined
  // 句柄不关的话临时目录在 Windows 上删不掉，`-wal` / `-shm` 也会留着。
  await closeSqliteConnections()
  await rm(home, { recursive: true, force: true })
})

describe('SQL 端点在同一条认证收口后面', () => {
  // 本卡最要紧的一条：SQL 端点若能未认证访问，那是把整个会话库（会话内容、恢复快照、撤销日志）
  // 对本机任意网页敞开——读得到、也写得进。
  it('无 token 的 sqlite_execute / sqlite_select → 401，且一个字节都没落盘', async () => {
    const port = await start()
    for (const path of [EXECUTE_PATH, SELECT_PATH]) {
      const response = await postSql(port, path, {
        connection: 'persistence',
        sql: 'CREATE TABLE leaked (id TEXT)',
      })
      expect(response.status).toBe(401)
      expect(response.headers['content-type']).toBe('application/json; charset=utf-8')
      expect(response.headers['www-authenticate']).toBe('Bearer')
      expect(JSON.parse(response.body)).toMatchObject({ error: 'missing_token' })
    }
    // 库文件根本没被打开过——认证发生在触达 host-node 之前，不是「跑完再拒绝」。
    await expect(stat(databasePath())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('token 错 → 401 invalid_token，同样没落盘', async () => {
    const port = await start()
    const response = await postSql(
      port,
      EXECUTE_PATH,
      { connection: 'persistence', sql: 'CREATE TABLE leaked (id TEXT)' },
      { authorization: 'Bearer wrong-token' },
    )
    expect(response.status).toBe(401)
    expect(JSON.parse(response.body)).toMatchObject({ error: 'invalid_token' })
    await expect(stat(databasePath())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  // 「没有第二扇门」的正面证据：任何别的 /api 路径既拿不到 SQL，也一样先过认证。
  it('/api/sql 不存在：无 token 回 401（连有没有这个接口都问不出），带 token 回 404', async () => {
    const port = await start()
    const anonymous = await postSql(port, '/api/sql', { connection: 'persistence', sql: 'SELECT 1' })
    expect(anonymous.status).toBe(401)

    const authenticated = await postSql(
      port,
      '/api/sql',
      { connection: 'persistence', sql: 'SELECT 1' },
      authorized(),
    )
    expect(authenticated.status).toBe(404)
    expect(JSON.parse(authenticated.body)).toMatchObject({ error: 'unknown_endpoint' })
  })
})

describe('带 token 的 SQL 端点真的能读写那个库文件', () => {
  it('建表 → 写入 → 读回，走的都是 /api/invoke/sqlite_*', async () => {
    const port = await start()

    const created = await postSql(port, EXECUTE_PATH, {
      connection: 'persistence',
      sql: 'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, meta TEXT NOT NULL)',
    }, authorized())
    expect(created.status).toBe(200)
    expect(JSON.parse(created.body)).toEqual({ rowsAffected: 0 })

    const inserted = await postSql(port, EXECUTE_PATH, {
      connection: 'persistence',
      sql: 'INSERT OR REPLACE INTO sessions (id, meta) VALUES ($1, $2)',
      params: ['s-1', '{"title":"第一个会话"}'],
    }, authorized())
    expect(inserted.status).toBe(200)
    expect(JSON.parse(inserted.body)).toEqual({ rowsAffected: 1 })

    const selected = await postSql(port, SELECT_PATH, {
      connection: 'persistence',
      sql: 'SELECT id, meta FROM sessions WHERE id = $1',
      params: ['s-1'],
    }, authorized())
    expect(selected.status).toBe(200)
    expect(JSON.parse(selected.body)).toEqual([{ id: 's-1', meta: '{"title":"第一个会话"}' }])

    // 落在**桌面版同一个位置**（`…/com.webagent.app/web-agent.db`，只是 home 换成了临时目录）。
    // 这正是 P2/P3 那句「两个宿主看到同一份会话」的物理条件。
    await expect(stat(databasePath())).resolves.toMatchObject({ size: expect.any(Number) })
  })

  // PRAGMA 会回一行当前值，所以它走 select 而不是 execute——`persistence-sqlite` 的 `getDb()`
  // 启动时就发三条。走错方法的后果是执行面把它判成非法语句，连接调优整段静默失效。
  it('PRAGMA 走 sqlite_select 并回一行', async () => {
    const port = await start()
    const response = await postSql(port, SELECT_PATH, {
      connection: 'persistence',
      sql: 'PRAGMA journal_mode=WAL',
    }, authorized())
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual([{ journal_mode: 'wal' }])
  })

  // P2 踩过的坑：node:sqlite 的 `prepare("INSERT a; INSERT b").run()` 回 `{changes:1}` 却只执行
  // 第一条——一张成功回执配一半的数据。这条判据必须在 HTTP 这条路上也成立（SQL 来自外部载荷）。
  // 只钉真正的不变量：**没有任何一条被执行**。状态码故意不钉，见文件头最后一段。
  it('多语句被拦下，且半份数据都不许落盘', async () => {
    const port = await start()
    const response = await postSql(port, EXECUTE_PATH, {
      connection: 'persistence',
      sql: 'CREATE TABLE first (id TEXT); CREATE TABLE second (id TEXT)',
    }, authorized())
    // 实测是 `500` + `text/plain` +「服务端内部错误。」（见文件头最后一段）。这里只钉「被拒了」，
    // 免得将来 invoke 路由把业务性失败改成 JSON 信封时，这条无关的用例跟着变红。
    expect(response.status).toBeGreaterThanOrEqual(400)

    const tables = await postSql(port, SELECT_PATH, {
      connection: 'persistence',
      sql: "SELECT name FROM sqlite_master WHERE type = 'table'",
    }, authorized())
    expect(tables.status).toBe(200)
    expect(JSON.parse(tables.body)).toEqual([])
  })
})
