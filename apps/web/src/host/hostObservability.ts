// 把当前宿主的 trace driver 装进 core —— 写入端与读取端是同一个决定的两半。
// ---------------------------------------------------------------------------
// 拆开写会出现「写进 SQLite、从 IndexedDB 读」这种两头对不上的装配，而它不会报错，只会让
// TraceViewer 恒空。所以两端在同一个函数里按同一个宿主判据选，调用方只看得到一个入口。
//
// 【为什么只有 tauri 一态用 SQLite】trace 落 SQLite 要 `@tauri-apps/plugin-sql`，那是桌面原生
// 通路。server 宿主的 SQL 端点是 P 线（P1–P4）的事，在它落地之前浏览器侧只有 IndexedDB
// 一种耐久存储，server 与 static 因此同待遇。
//
// 【读取端为什么多一个 DEV 分支】浏览器 dev 预览要能看桌面端写下的 trace（同机调试的主要用途），
// 走 `createDevSqliteLogReader`——它经 Vite dev 中继读同一份 SQLite 文件。这条与宿主态正交：
// 判的是「这份产物是不是 dev 起的」，不是「宿主是哪一态」。
import {
  configureObservability,
  configureTraceLogReader as configureTraceLogReaderFactory,
} from '@einfach-agent/core/observability'
import { createIndexedDbLogDriver, createIndexedDbLogReader } from '@einfach-agent/observability-idb'
import type { ResolvedHost } from './resolveHost'

function configureLogDriver(host: ResolvedHost): void {
  if (host.kind === 'tauri') {
    void import('@einfach-agent/observability-sqlite')
      .then(({ createSqliteLogDriver }) => configureObservability({ driver: createSqliteLogDriver() }))
      .catch(() => {})
    return
  }
  configureObservability({ driver: createIndexedDbLogDriver() })
}

function configureLogReader(host: ResolvedHost): void {
  if (host.kind === 'tauri') {
    configureTraceLogReaderFactory(async () => {
      const { createSqliteLogReader } = await import('@einfach-agent/observability-sqlite')
      return createSqliteLogReader()
    })
    return
  }
  if (import.meta.env.DEV) {
    configureTraceLogReaderFactory(async () => {
      const { createDevSqliteLogReader } = await import('@einfach-agent/observability-sqlite')
      return createDevSqliteLogReader()
    })
    return
  }
  configureTraceLogReaderFactory(createIndexedDbLogReader)
}

/** 按解析出的宿主配置 trace 的写入 driver 与读取 reader。 */
export function configureHostObservability(host: ResolvedHost): void {
  configureLogDriver(host)
  configureLogReader(host)
}
