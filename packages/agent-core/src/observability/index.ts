// `@web-agent/core/observability` 的公开面 barrel —— 只收 ObservabilityPort 契约、
// trace 线协议类型与 trace 配置入口等纯逻辑公开面，供 observability-idb /
// observability-sqlite 两个 driver 包与需要读写 trace 的能力包消费。判据见
// docs/core-public-surface-audit.md §3.3 C 类「观测 driver」一行、§4 白名单方案第 7 条。
//
// 刻意不收（盘点 E3 内部泄漏，处置留给 docs/core-surface-issues.md 的 S7 卡，
// 本 barrel 不为它背书）：
// - ./traceCacheTotals（E3）：从 trace 反推缓存总量的 UI 专用补偿逻辑，是观测内部
//   实现细节而非观测契约；唯一消费方 apps/web/.../ContextStats.tsx 仍走 `./*` 通配。

export type { TraceStatus, SpanKind, TraceAttributes, TraceSpan, TraceEvent, TraceDriver } from './types'

export type { TraceLogSnapshot, TraceLogReader } from './logReader'
export { configureTraceLogReader, createTraceLogReader } from './logReader'

export type { ObservabilityPort, PerformanceDiagnosticLog, PerformanceDiagnosticSink } from './port'

export { configureObservability, resetObservability, flushObservability, recordCompletedSpan } from './trace'

export { performanceNow, beginPerformanceDiagnostic, recordPerformanceDiagnostic } from './performanceDiagnostics'
