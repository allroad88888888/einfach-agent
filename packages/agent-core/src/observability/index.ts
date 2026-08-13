// `@web-agent/core/observability` 的公开面 barrel —— 只收 ObservabilityPort 契约、
// trace 线协议类型与 trace 配置入口等纯逻辑公开面，供 observability-idb /
// observability-sqlite 两个 driver 包与需要读写 trace 的能力包消费。判据见
// docs/core-public-surface-audit.md §3.3 C 类「观测 driver」一行、§4 白名单方案第 7 条。
//
// E3（S7a 已处置）：`./traceCacheTotals` 收进本 barrel。它没有等价公开 API 可换——两个函数
// 只用 TraceLogSnapshot + createTraceLogReader 这两样已公开的读侧契约做聚合，让宿主自己重写
// 等于把 span 名与 cache_hit_tk / cache_miss_tk 两个 attr 名抄进 apps/web。故按 S7a「需发明新
// API 的先补 barrel 并记债」办：作为 reader 侧派生 API 公开，债务记在
// docs/core-public-surface-audit.md §3.5 E3 行（contextStats 落盘补齐后应连同实现一起删）。

export type { TraceStatus, SpanKind, TraceAttributes, TraceSpan, TraceEvent, TraceDriver } from './types'

export type { TraceLogSnapshot, TraceLogReader } from './logReader'
export { configureTraceLogReader, createTraceLogReader } from './logReader'

export type { ObservabilityPort, PerformanceDiagnosticLog, PerformanceDiagnosticSink } from './port'

export { configureObservability, resetObservability, flushObservability, recordCompletedSpan } from './trace'

export { performanceNow, beginPerformanceDiagnostic, recordPerformanceDiagnostic } from './performanceDiagnostics'

export { cacheTotalsFromTrace, recoverCacheTotalsFromTrace } from './traceCacheTotals'
