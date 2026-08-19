// trace 的写入端与读取端各自被配成了什么 —— 两端是同一个决定的两半。
// ---------------------------------------------------------------------------
// 拆开写会出现「写进 SQLite、从 IndexedDB 读」这种两头对不上的装配，而它**不会报错**，只会让
// TraceViewer 恒空。所以每条用例都同时断言两端，绝不只查一半。
// driver / reader 五个工厂全部换成哨兵对象，本文件不开任何一个真实存储。
//
// ★ 顺序敏感点：`configureLogReader` 里 tauri 必须排在 DEV 之前 ★
// 两个判据正交——宿主是解析出来的，DEV 是构建模式。桌面端开发时（`pnpm tauri dev`）两者**同时为真**，
// 此刻若 DEV 赢，读取端会走 `createDevSqliteLogReader`（经 Vite dev 中继读文件）而写入端仍是
// `createSqliteLogDriver`（经 Tauri 原生 SQL 插件写库）。这不是「读不到」那么简单：它是两条不同的
// 通路读同一份库，桌面端最常用的那个形态从此不在任何测试的覆盖里。
// 只测「构建产物形态」是钉不住这条的——`pnpm build` 出来的桌面产物 DEV 为假，两个分支谁前谁后都绿。
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
  configureObservability: vi.fn(),
  configureTraceLogReader: vi.fn(),
  createSqliteLogDriver: vi.fn(),
  createIndexedDbLogDriver: vi.fn(),
  createSqliteLogReader: vi.fn(),
  createDevSqliteLogReader: vi.fn(),
  createIndexedDbLogReader: vi.fn(),
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
  createSqliteLogDriver: mocks.createSqliteLogDriver,
  createSqliteLogReader: mocks.createSqliteLogReader,
  createDevSqliteLogReader: mocks.createDevSqliteLogReader,
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

/** 写入端是 `configureObservability({ driver })`；桌面那条经动态 import，所以要等一拍。 */
async function resolvedDriver(): Promise<unknown> {
  await vi.waitFor(() => { expect(mocks.configureObservability).toHaveBeenCalled() })
  const call = mocks.configureObservability.mock.calls.at(-1)
  return (call?.[0] as { driver?: unknown } | undefined)?.driver
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
  })

  it('tauri + DEV 同时为真（pnpm tauri dev）时两端都是 SQLite，dev 中继抢不走读取端', async () => {
    setDev(true)
    configureHostObservability({ kind: 'tauri' })

    expect(await resolvedDriver()).toBe(mocks.sqliteDriver)
    expect(await resolvedReader()).toBe(mocks.sqliteReader)
    // 不只是「读取端对」：dev 中继那条连造都没造出来。
    expect(mocks.createDevSqliteLogReader).not.toHaveBeenCalled()
    // 写入端也不许顺带落一个 IndexedDB driver（tauri 那支漏了 return 就会两个都配，后者赢）。
    expect(mocks.createIndexedDbLogDriver).not.toHaveBeenCalled()
    expect(mocks.createIndexedDbLogReader).not.toHaveBeenCalled()
  })

  it('tauri 的构建产物同样两端 SQLite', async () => {
    setDev(false)
    configureHostObservability({ kind: 'tauri' })

    expect(await resolvedDriver()).toBe(mocks.sqliteDriver)
    expect(await resolvedReader()).toBe(mocks.sqliteReader)
    expect(mocks.createIndexedDbLogDriver).not.toHaveBeenCalled()
  })

  it('server 宿主的构建产物两端都是 IndexedDB，一次都不碰 SQLite 那条通路', async () => {
    // trace 落 SQLite 要 `@tauri-apps/plugin-sql`，那是桌面原生通路；server 的 SQL 端点是 P 线的事。
    setDev(false)
    configureHostObservability(serverHost)

    expect(await resolvedDriver()).toBe(mocks.idbDriver)
    expect(await resolvedReader()).toBe(mocks.idbReader)
    expect(mocks.createSqliteLogDriver).not.toHaveBeenCalled()
    expect(mocks.createSqliteLogReader).not.toHaveBeenCalled()
    expect(mocks.createDevSqliteLogReader).not.toHaveBeenCalled()
  })

  it('static 宿主的构建产物两端都是 IndexedDB', async () => {
    setDev(false)
    configureHostObservability(staticHost)

    expect(await resolvedDriver()).toBe(mocks.idbDriver)
    expect(await resolvedReader()).toBe(mocks.idbReader)
    expect(mocks.createSqliteLogDriver).not.toHaveBeenCalled()
    expect(mocks.createDevSqliteLogReader).not.toHaveBeenCalled()
  })

  it('读取端登记的是工厂本身而不是已造好的 reader（惰性）', () => {
    setDev(false)
    configureHostObservability(staticHost)

    // 非 tauri、非 DEV 这一支把 `createIndexedDbLogReader` **原样**交给 core，
    // 所以登记那一刻它还没被调用过——打开 IndexedDB 连接被推迟到 TraceViewer 真的要读的时候。
    expect(mocks.configureTraceLogReader).toHaveBeenCalledWith(mocks.createIndexedDbLogReader)
    expect(mocks.createIndexedDbLogReader).not.toHaveBeenCalled()
  })

  it('浏览器 dev 预览（static + DEV）写 IndexedDB、读 dev 中继 —— 这条与宿主态正交', async () => {
    setDev(true)
    configureHostObservability(staticHost)

    expect(await resolvedDriver()).toBe(mocks.idbDriver)
    expect(await resolvedReader()).toBe(mocks.devSqliteReader)
    expect(mocks.createIndexedDbLogReader).not.toHaveBeenCalled()
  })

  it('server + DEV 的混合会话：写 IndexedDB、读 dev 中继（当前行为，两端不同源）', async () => {
    // 「`pnpm dev` 的前端 + 真 apps/server 后端」这个混合形态里，DEV 分支照样赢过 server 宿主：
    // 本轮 trace 写进 IndexedDB，TraceViewer 读到的却是桌面端那份 SQLite 文件。
    // 本用例**只钉住当前行为**，不代表它是对的——文件头声称「两端在同一个函数里按同一个宿主判据选」，
    // 而读取端多出来的这个判据恰好在这一格上把两端劈开了。结论见本卡报告。
    setDev(true)
    configureHostObservability(serverHost)

    expect(await resolvedDriver()).toBe(mocks.idbDriver)
    expect(await resolvedReader()).toBe(mocks.devSqliteReader)
  })
})
