// trace 的写入端与读取端各自被配成了什么 —— 两端是同一个决定的两半。
// ---------------------------------------------------------------------------
// 拆开写会出现「写进 SQLite、从 IndexedDB 读」这种两头对不上的装配，而它**不会报错**，只会让
// TraceViewer 恒空。所以每条用例都同时断言两端，绝不只查一半。
// 五个工厂 + 两条 SQL 执行面全部换成哨兵，本文件不开任何一个真实存储。
//
// ★ P4 之后判据换了：从「是不是 tauri」换成「这一态有没有 SQL 通路」★
// observability-sqlite 收敛到注入的 `SqlExecutor` 之后，server 宿主也有了 SQL 通路
// （`POST /api/invoke/sqlite_*`），于是它**两端都走 SQLite**、不再与 static 同待遇。
// 本文件 P4 之前的版本曾把「server 写 IndexedDB、读桌面那份 SQLite」当作**当前行为**钉住，并在
// 注释里写明「不代表它是对的」——现在它变对了，那两条已改成正面断言（见下面 server 那两条）。
//
// ★ 顺序敏感点有两处 ★
//   ① 读取端的 DEV 分支必须排在「有没有 SQL 通路」之后。有 SQL 通路的两态（tauri / server）
//      在 `pnpm tauri dev`、`pnpm dev + 真后端` 这两种日常形态下 DEV **同时为真**，此刻若 DEV 赢，
//      写入端仍是 SQLite 而读取端跑去经 Vite dev 中继读桌面那份库文件——两端劈开，且不报错。
//      只测「构建产物形态」是钉不住它的：那时 DEV 为假，两个分支谁前谁后都绿。
//   ② `configureTraceSqlExecutor(loadExecutor)` 必须与「这一态用 SQLite」的判断同处一地，
//      且早于 driver 造出来。分开写就有「选了 SQLite 却没配执行面」的中间态，而 driver 是
//      best-effort、不会喊，症状是 trace 静默不落盘。
//
// `import.meta.env.DEV` 在 vitest 下**默认为 true**，所以每条用例都显式 stub：不 stub 的用例测的
// 其实是 dev 形态，而且它会绿。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedHost } from './resolveHost'

const mocks = vi.hoisted(() => ({
  sqliteDriver: { tag: 'sqlite-log-driver' },
  idbDriver: { tag: 'indexeddb-log-driver' },
  sqliteReader: { tag: 'sqlite-log-reader' },
  devSqliteReader: { tag: 'dev-sqlite-log-reader' },
  idbReader: { tag: 'indexeddb-log-reader' },
  tauriExecutor: { tag: 'tauri-sql-executor' },
  serverExecutor: { tag: 'server-sql-executor' },
  configureObservability: vi.fn(),
  configureTraceLogReader: vi.fn(),
  configureTraceSqlExecutor: vi.fn(),
  createSqliteLogDriver: vi.fn(),
  createIndexedDbLogDriver: vi.fn(),
  createSqliteLogReader: vi.fn(),
  createDevSqliteLogReader: vi.fn(),
  createIndexedDbLogReader: vi.fn(),
  loadTauriSqlExecutor: vi.fn(),
  createServerSqlExecutor: vi.fn(),
}))

vi.mock('@einfach-agent/core/observability', () => ({
  configureObservability: mocks.configureObservability,
  configureTraceLogReader: mocks.configureTraceLogReader,
}))
vi.mock('@einfach-agent/observability-idb', () => ({
  createIndexedDbLogDriver: mocks.createIndexedDbLogDriver,
  createIndexedDbLogReader: mocks.createIndexedDbLogReader,
}))
vi.mock('@einfach-agent/observability-sqlite', () => ({
  configureTraceSqlExecutor: mocks.configureTraceSqlExecutor,
  createSqliteLogDriver: mocks.createSqliteLogDriver,
  createSqliteLogReader: mocks.createSqliteLogReader,
  createDevSqliteLogReader: mocks.createDevSqliteLogReader,
}))
vi.mock('../persistence/tauriSqlExecutor', () => ({
  loadTauriSqlExecutor: mocks.loadTauriSqlExecutor,
}))
vi.mock('../persistence/serverSqlExecutor', () => ({
  createServerSqlExecutor: mocks.createServerSqlExecutor,
}))

const { configureHostObservability } = await import('./hostObservability')

const serverHost: ResolvedHost = { kind: 'server', platform: 'linux' }
const staticHost: ResolvedHost = { kind: 'static', reason: 'unreachable' }

function setDev(value: boolean): void {
  vi.stubEnv('DEV', value)
}

/** 登记进 core 的读取端是个**工厂**（惰性），所以身份要现造出来比。 */
async function resolvedReader(): Promise<unknown> {
  const call = mocks.configureTraceLogReader.mock.calls.at(-1)
  if (!call) throw new Error('读取端一次都没被登记——两端必须成对，缺一半就是 TraceViewer 恒空')
  const factory = call[0] as () => Promise<unknown> | unknown
  return await factory()
}

/** 写入端是 `configureObservability({ driver })`；SQLite 那条经动态 import，所以要等一拍。 */
async function resolvedDriver(): Promise<unknown> {
  await vi.waitFor(() => { expect(mocks.configureObservability).toHaveBeenCalled() })
  const call = mocks.configureObservability.mock.calls.at(-1)
  return (call?.[0] as { driver?: unknown } | undefined)?.driver
}

/** 注入给 observability-sqlite 的执行面 loader 同样是惰性的，也要现解析出来比身份。 */
async function injectedSqlExecutor(): Promise<unknown> {
  await vi.waitFor(() => { expect(mocks.configureTraceSqlExecutor).toHaveBeenCalled() })
  const call = mocks.configureTraceSqlExecutor.mock.calls.at(-1)
  const loader = call?.[0] as () => Promise<unknown>
  return await loader()
}

describe('configureHostObservability', () => {
  beforeEach(() => {
    // vitest 4 的 `restoreMocks: true` 只管 `vi.spyOn` 造的 spy，**不碰 `vi.fn()`**——
    // 下面每条用例都有「另一条通路一次都没被造出来」的断言，不清就会读到上一条用例的账。
    vi.clearAllMocks()
    mocks.createSqliteLogDriver.mockReturnValue(mocks.sqliteDriver)
    mocks.createIndexedDbLogDriver.mockReturnValue(mocks.idbDriver)
    mocks.createSqliteLogReader.mockReturnValue(mocks.sqliteReader)
    mocks.createDevSqliteLogReader.mockReturnValue(mocks.devSqliteReader)
    mocks.createIndexedDbLogReader.mockReturnValue(mocks.idbReader)
    mocks.loadTauriSqlExecutor.mockResolvedValue(mocks.tauriExecutor)
    mocks.createServerSqlExecutor.mockReturnValue(mocks.serverExecutor)
  })

  it('tauri + DEV 同时为真（pnpm tauri dev）时两端都是 SQLite，dev 中继抢不走读取端', async () => {
    setDev(true)
    configureHostObservability({ kind: 'tauri' })

    expect(await resolvedDriver()).toBe(mocks.sqliteDriver)
    expect(await resolvedReader()).toBe(mocks.sqliteReader)
    expect(await injectedSqlExecutor()).toBe(mocks.tauriExecutor)
    // 不只是「读取端对」：dev 中继那条连造都没造出来。
    expect(mocks.createDevSqliteLogReader).not.toHaveBeenCalled()
    // 写入端也不许顺带落一个 IndexedDB driver（SQLite 那支漏了 return 就会两个都配，后者赢）。
    expect(mocks.createIndexedDbLogDriver).not.toHaveBeenCalled()
    expect(mocks.createIndexedDbLogReader).not.toHaveBeenCalled()
  })

  it('tauri 的构建产物同样两端 SQLite，执行面是桌面原生那条', async () => {
    setDev(false)
    configureHostObservability({ kind: 'tauri' })

    expect(await resolvedDriver()).toBe(mocks.sqliteDriver)
    expect(await resolvedReader()).toBe(mocks.sqliteReader)
    expect(await injectedSqlExecutor()).toBe(mocks.tauriExecutor)
    expect(mocks.createServerSqlExecutor).not.toHaveBeenCalled()
    expect(mocks.createIndexedDbLogDriver).not.toHaveBeenCalled()
  })

  it('server 宿主的构建产物两端都是 SQLite，执行面是打到本机后端的那条（P4：不再与 static 同待遇）', async () => {
    setDev(false)
    configureHostObservability(serverHost)

    expect(await resolvedDriver()).toBe(mocks.sqliteDriver)
    expect(await resolvedReader()).toBe(mocks.sqliteReader)
    expect(await injectedSqlExecutor()).toBe(mocks.serverExecutor)
    // 取的是 trace 那条**逻辑连接**，不是 persistence 那条：同一个库文件，两组表
    // （trace_spans / trace_events vs sessions / recovery_snapshots / history_log）。
    expect(mocks.createServerSqlExecutor).toHaveBeenCalledWith('observability')
    // 桌面原生那条执行面在浏览器里根本不存在，碰一下就是错。
    expect(mocks.loadTauriSqlExecutor).not.toHaveBeenCalled()
    expect(mocks.createIndexedDbLogDriver).not.toHaveBeenCalled()
    expect(mocks.createIndexedDbLogReader).not.toHaveBeenCalled()
  })

  it('server + DEV 的混合会话两端仍是 SQLite，dev 中继抢不走读取端（顺序判据）', async () => {
    // 「`pnpm dev` 的前端 + 真 apps/server 后端」这个混合形态，是 P4 之前**两端被劈开**的那一格：
    // 写进 IndexedDB、读桌面那份 SQLite，TraceViewer 一条都看不到，且不报错（B5 报出、立卡 B7）。
    // 判据换成「有没有 SQL 通路」之后 server 走不到 DEV 那支了，本条就是它的回归网——
    // 谁把 DEV 判据挪回宿主判据之前，这里立刻转红。
    setDev(true)
    configureHostObservability(serverHost)

    expect(await resolvedDriver()).toBe(mocks.sqliteDriver)
    expect(await resolvedReader()).toBe(mocks.sqliteReader)
    expect(await injectedSqlExecutor()).toBe(mocks.serverExecutor)
    expect(mocks.createDevSqliteLogReader).not.toHaveBeenCalled()
    expect(mocks.createIndexedDbLogDriver).not.toHaveBeenCalled()
  })

  it('选了 SQLite 就在同一地把执行面注入进去，且早于 driver 造出来', async () => {
    // P4 的硬约束：注入执行面与「这一态用 SQLite」的判断必须同处一地。分开写就有
    // 「选了 SQLite 却没配执行面」的中间态，而 driver 是 best-effort、不会喊——
    // 症状是 trace 静默不落盘，谁都不会在第一现场发现。
    setDev(false)
    configureHostObservability({ kind: 'tauri' })
    await resolvedDriver()

    expect(mocks.configureTraceSqlExecutor).toHaveBeenCalledOnce()
    const injectedAt = mocks.configureTraceSqlExecutor.mock.invocationCallOrder[0]
    const driverBuiltAt = mocks.createSqliteLogDriver.mock.invocationCallOrder[0]
    expect(injectedAt).toBeLessThan(driverBuiltAt)
  })

  it('static 宿主的构建产物两端都是 IndexedDB，一次都不碰 SQL 通路', async () => {
    // 没有后端就没有 SQL 通路：既不注入执行面，也不造任何 SQLite 端点。
    setDev(false)
    configureHostObservability(staticHost)

    expect(await resolvedDriver()).toBe(mocks.idbDriver)
    expect(await resolvedReader()).toBe(mocks.idbReader)
    expect(mocks.configureTraceSqlExecutor).not.toHaveBeenCalled()
    expect(mocks.createSqliteLogDriver).not.toHaveBeenCalled()
    expect(mocks.createSqliteLogReader).not.toHaveBeenCalled()
    expect(mocks.createDevSqliteLogReader).not.toHaveBeenCalled()
  })

  it('读取端登记的是工厂本身而不是已造好的 reader（惰性）', () => {
    setDev(false)
    configureHostObservability(staticHost)

    // 没有 SQL 通路、又不是 DEV 的这一支把 `createIndexedDbLogReader` **原样**交给 core，
    // 所以登记那一刻它还没被调用过——打开 IndexedDB 连接被推迟到 TraceViewer 真的要读的时候。
    expect(mocks.configureTraceLogReader).toHaveBeenCalledWith(mocks.createIndexedDbLogReader)
    expect(mocks.createIndexedDbLogReader).not.toHaveBeenCalled()
  })

  it('static + DEV 写 IndexedDB、读桌面那份 SQLite —— 这一格两端不同源是刻意的', async () => {
    // **这一格与 server 那格曾经的「不同源」不是一回事。**
    // server 那格是缺陷：写进 IndexedDB 的 trace 自己读不回来，TraceViewer 对着本轮会话恒空。
    // 这一格是设计：`pnpm dev` 的浏览器预览没有任何 SQL 通路（写只能落 IndexedDB），而它的
    // 主要用途恰恰是**同机调试**——看的是桌面端刚写下的那份 SQLite，不是自己这一轮的 trace。
    // 判据也因此与宿主态正交：判的是「这份产物是不是 dev 起的」，不是「宿主是哪一态」。
    setDev(true)
    configureHostObservability(staticHost)

    expect(await resolvedDriver()).toBe(mocks.idbDriver)
    expect(await resolvedReader()).toBe(mocks.devSqliteReader)
    expect(mocks.createIndexedDbLogReader).not.toHaveBeenCalled()
    // dev 中继自己读文件，不经注入的执行面。
    expect(mocks.configureTraceSqlExecutor).not.toHaveBeenCalled()
  })

  it('SQLite 包加载失败时不抛给调用方，但写入端**静默**缺席（B7 第 ② 条的现状档案）', async () => {
    // `configureSqliteTrace` 里那句 `.catch(() => {})` 把加载失败整个吞掉：
    //   · 读取端仍被登记，工厂 await 的是同一个已 reject 的 promise —— TraceViewer 会喊；
    //   · 写入端这一半 `configureObservability` **一次都没被调用**，而 core 的 enqueue() 在没有
    //     driver 时直接丢弃 span（observability/trace.ts:56）。既不回落 IndexedDB，也没有告警。
    // 本条只是把这个不对称钉成档案：B7 落地（回落或至少喊一声）时它必然转红，那正是它该做的事。
    vi.resetModules()
    vi.doMock('@einfach-agent/observability-sqlite', async () => {
      throw new Error('模拟 SQLite 端点所在的那个 chunk 加载失败')
    })
    try {
      const fresh = await import('./hostObservability')
      setDev(false)
      expect(() => fresh.configureHostObservability({ kind: 'tauri' })).not.toThrow()

      await expect(resolvedReader()).rejects.toThrow()
      await new Promise((resolve) => { setTimeout(resolve, 0) })
      expect(mocks.configureObservability).not.toHaveBeenCalled()
      expect(mocks.configureTraceSqlExecutor).not.toHaveBeenCalled()
    } finally {
      vi.doUnmock('@einfach-agent/observability-sqlite')
      vi.resetModules()
    }
  })
})
