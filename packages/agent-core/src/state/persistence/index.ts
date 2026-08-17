// `@web-agent/core/state/persistence` 的公开面 barrel —— 持久化 contract 面：driver 接口、
// 配套的 checkpoint 数据类型，以及契约自带的那个零依赖内存实现，供 persistence-idb /
// persistence-sqlite 两个 driver 包与无盘宿主（apps/cli）消费。判据见
// docs/core-public-surface-audit.md §3.3 C 类「持久化 driver」一行、§4 白名单方案第 6 条。
//
// 收两个内存 driver（`createMemoryRecoveryDriver` / `createMemoryHistoryLogDriver`）的理由
//   （盘点 E6，卡 S7b 判定）：它们是各自契约的参考实现——只 import 本目录的类型，零宿主依赖
//   （无 idb / 无 tauri-plugin-sql），语义就是「进程内 Map，不落盘」，不会随 core 内部重构而变。
//   apps/cli 是真实产品消费方（headless 跑一轮不需要盘），让它复制一份实现比公开工厂更糟。
//   （原先这段写的是 `./memoryHistoryDriver`，那是轮级 checkpoint 的 HistoryDriver，已随
//   checkpoint 整体删除；现在这里指的是事务日志的 HistoryLogDriver，两者不是一回事。）
//
// 刻意不收（本 barrel 不为它们背书）：
// - ./hydrate（E4，S7a 已消）：持久化启动步骤的内部实现，宿主走 runtime/persistenceBridge
//   的 hydratePersistence()，不该直接拼装 hydrate。
// - ./sessionsPersistence（E5，S7b 已消）：那是 IndexedDB 实现，已搬去
//   `@web-agent/persistence-idb`（与 createIndexedDbHistoryDriver 同包），core 只留 contract。

export type { SessionsPersistence } from './contract'
export type { RecoveryDriver, RecoverySaveResult } from './recoveryDriver'
export {
  createMemoryRecoveryDriver,
  validateRecoverySnapshot,
} from './recoveryDriver'
export type { RecoverySnapshotV1 } from '../recoverySnapshot.type'
export type { HistoryLogDriver, PersistedHistoryLog } from './historyLogDriver'
export {
  createMemoryHistoryLogDriver,
  toPersistableHistoryLog,
} from './historyLogDriver'
