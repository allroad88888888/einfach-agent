// 把当前宿主的 trace driver 装进 core —— 写入端与读取端是同一个决定的两半。
// ---------------------------------------------------------------------------
// 拆开写会出现「写进 SQLite、从 IndexedDB 读」这种两头对不上的装配，而它不会报错，只会让
// TraceViewer 恒空。所以两端在同一个函数里按同一个宿主判据选，调用方只看得到一个入口。
//
// 【P4 之后判据换了】以前是「是不是 tauri」——因为 trace 落 SQLite 要 `@tauri-apps/plugin-sql`，
// 那是桌面原生通路。P4 把 observability-sqlite 收敛到注入的 `SqlExecutor` 之后，判据变成
// **「这一态有没有 SQL 通路」**，与 `persistence/persistenceDrivers.ts` 逐字相同；server 宿主
// 因此两端都走 SQLite（经 `POST /api/invoke/sqlite_*`），不再与 static 同待遇。
// 两处取的是**同一个库文件的两条逻辑连接**：persistence 写 sessions / recovery_snapshots /
// history_log，本文件这条写 trace_spans / trace_events（词表见 host-node 的 sqlite/connectionNames.ts）。
//
// 【读取端那个 DEV 分支现在只对没有 SQL 通路的那一态生效】浏览器 dev 预览要能看桌面端写下的
// trace（同机调试的主要用途），走 `createDevSqliteLogReader` 经 Vite dev 中继读同一份 SQLite 文件。
// 这是**有意的「写 IndexedDB、读桌面 SQLite」**——它服务的是 static + DEV。
// B5 报过：P4 之前 `server + DEV` 也会落进这个分支，于是 server 宿主写 IndexedDB 却读桌面那份
// SQLite，TraceViewer 一条看不到；判据换成「有没有 SQL 通路」之后 server 走不到这里了。
import {
  configureObservability,
  configureTraceLogReader as configureTraceLogReaderFactory,
} from '@einfach-agent/core/observability'
import { createIndexedDbLogDriver, createIndexedDbLogReader } from '@einfach-agent/observability-idb'
import type { SqlExecutorLoader } from '@einfach-agent/core/state/persistence'
import type { ResolvedHost } from './resolveHost'

/**
 * 这一态有没有 SQL 通路；有的话给出 trace 那条逻辑连接的执行面 loader。
 *
 * 判据与 `persistence/persistenceDrivers.ts` 逐字相同（「这一态有没有 SQL 通路」，不是「有没有
 * 本机能力桥」）。两处取的是**同一个库文件的两条逻辑连接**：persistence 那条写 sessions /
 * recovery_snapshots / history_log，observability 这条写 trace_spans / trace_events
 * （连接名词表见 host-node 的 sqlite/connectionNames.ts）。
 */
function traceSqlExecutorLoader(host: ResolvedHost): SqlExecutorLoader | undefined {
  if (host.kind === 'tauri') {
    return async () => (await import('../persistence/tauriSqlExecutor')).loadTauriSqlExecutor()
  }
  if (host.kind === 'server') {
    return async () => (await import('../persistence/serverSqlExecutor')).createServerSqlExecutor('observability')
  }
  return undefined
}

/**
 * 装 SQLite 那一组 trace 端点，并把这一态的 SQL 执行面注入进去。
 *
 * 注入执行面与「这一态用 SQLite」的判断必须同处一地——分开写就会有「选了 SQLite 却没配执行面」
 * 的中间态，而那一态的症状是 trace 静默不落盘（driver 是 best-effort）。
 *
 * 两端共用同一个 `import()` 的 promise：写入端那条 `.then` 先注册，所以 `configureTraceSqlExecutor`
 * 一定早于读取端工厂里的 `await`（读取端工厂要到 TraceViewer 打开时才被调用，更晚）。
 */
function configureSqliteTrace(loadExecutor: SqlExecutorLoader): void {
  const sqliteModule = import('@einfach-agent/observability-sqlite')
  void sqliteModule
    .then(({ configureTraceSqlExecutor, createSqliteLogDriver }) => {
      configureTraceSqlExecutor(loadExecutor)
      configureObservability({ driver: createSqliteLogDriver() })
    })
    .catch(() => {})
  configureTraceLogReaderFactory(async () => (await sqliteModule).createSqliteLogReader())
}

/** 按解析出的宿主配置 trace 的写入 driver 与读取 reader。 */
export function configureHostObservability(host: ResolvedHost): void {
  const loadExecutor = traceSqlExecutorLoader(host)
  if (loadExecutor) {
    configureSqliteTrace(loadExecutor)
    return
  }
  configureObservability({ driver: createIndexedDbLogDriver() })
  if (import.meta.env.DEV) {
    configureTraceLogReaderFactory(async () => {
      const { createDevSqliteLogReader } = await import('@einfach-agent/observability-sqlite')
      return createDevSqliteLogReader()
    })
    return
  }
  configureTraceLogReaderFactory(createIndexedDbLogReader)
}
