// `@web-agent/core/state/persistence` 的公开面 barrel —— 只收持久化 contract 面：
// driver 接口与配套的 checkpoint 数据类型，供 persistence-idb / persistence-sqlite
// 两个 driver 包实现落地时消费。判据见 docs/core-public-surface-audit.md §3.3 C 类
// 「持久化 driver」一行、§4 白名单方案第 6 条。
//
// 刻意不收（盘点 E 类内部泄漏，E4–E6 逐条点名，处置留给
// docs/core-surface-issues.md 的 S7 卡，本 barrel 不为它们背书）：
// - ./hydrate（E4）：持久化启动步骤的内部实现，宿主应走 runtime/persistenceBridge
//   这条已存在的正式收口，而不是直接拼装 hydrate。
// - ./sessionsPersistence（E5）：内部工厂实现，同 E4 应换正式通路。
// - ./memoryHistoryDriver（E6）：内存 HistoryDriver 实现；apps/cli 当前仍深导入它，
//   它不进本 barrel 不影响 CLI ——CLI 的深导入继续走 `./*` 通配（S6/S7 再处理）。

export type { SessionsPersistence } from './contract'
export type { HistoryDriver } from './historyDriver'
export type {
  Checkpoint,
  CheckpointMeta,
  CheckpointKind,
  CheckpointFinishReason,
} from '../checkpoint.type'
