// 会话事务日志的持久化契约与零依赖内存实现。
// ---------------------------------------------------------------------------
// ## 为什么不是 einfach 的 `HistoryPersistPort`
//
// einfach 提供的端口是**增量镜像**：`append` / `dropOldest` / `dropAfter` / `setCursor` 逐笔跟随
// 内存变化。对纯粹的「让日志活过刷新」它是够的，但对本仓不够，因为这里还有第二份持久化真相 ——
// `RecoverySnapshotV1`。两者时点不一致就会静默损坏：
//
//   · 日志每次写入都记账；快照在耐久性栅栏才落盘（`persistRecovery`，含轮内的
//     `tool_call_execution_started`）。
//   · 崩溃后盘上是「快照停在某个栅栏 + 日志多出栅栏之后的条目」。
//   · 此时 undo 会把**更早状态的 `before`** 写进当前世界。反向偏移（快照比日志新）同样错：
//     日志最新那条的 `after` 不再等于当前值，undo 会把那之后的写入一起吃掉。
//
// 结论：日志与快照必须**成对**。所以这里不做增量镜像，而是在快照落盘成功的同一时刻，
// 用 einfach 的 `getState()` 整份刷盘，并把**那次快照的 `generation`** 一起存下；
// 读回时只在 `generation` 与快照一致时才 `hydrate()`，不一致就整份丢弃 —— 撤销不可用，
// 但状态是对的。fail-closed。
//
// 顺带两个好处：IO 从「每次状态写入」降到「每个栅栏一次」；不必和端口的下标语义纠缠
// （`dropOldest` / `dropAfter` 都是下标，端口若自行丢条目，坐标系会与内存永久错开）。
//
// 每个 session 一条、可覆盖，与 `RecoveryDriver` 同构。

import type { HistoryEntry, HistoryStackState } from '@einfach/core'

/** 一份可落盘的日志：条目、游标，以及与它配对的那份恢复快照的 generation。 */
export interface PersistedHistoryLog {
  /**
   * 与本日志配对的 `RecoverySnapshotV1.generation`。
   *
   * 读回时的唯一判据：与快照的 generation 不等 → 这份日志描述的不是快照那个世界，整份丢弃。
   */
  generation: number
  entries: HistoryEntry[]
  cursor: number
}

/** 每个 session 一条、可覆盖的事务日志；与恢复快照配对，不独立成为真相。 */
export interface HistoryLogDriver {
  load(sessionId: string): Promise<PersistedHistoryLog | undefined>
  save(sessionId: string, log: PersistedHistoryLog): Promise<void>
  /** 会话删除后清掉它的日志；不留 tombstone —— 日志本身不是真相，快照那侧已经 fence 住了。 */
  deleteSession(sessionId: string): Promise<void>
}

/**
 * 把内存日志转成可落盘的形状；不可 JSON 序列化则返回 undefined。
 *
 * 强制走一遍 JSON 往返，理由与 `validateRecoverySnapshot` 相同：日志不是可信边界。
 * 记账载荷来自各槽位的写入器，某个槽位哪天塞进一个类实例或闭包，这里当场拦住，
 * 而不是等到读回时 `hydrate()` 丢掉半条日志。
 *
 * 往返也顺手把 `before: undefined` 这类键抹掉 —— 那是 append op 的正常形状
 * （逆操作靠 `op.scope` 定位，不读 `before`），抹掉不影响还原。
 */
export function toPersistableHistoryLog(
  generation: number,
  state: HistoryStackState,
): PersistedHistoryLog | undefined {
  const candidate: PersistedHistoryLog = {
    generation,
    entries: [...state.entries],
    cursor: state.cursor,
  }
  try {
    const json = JSON.stringify(candidate)
    if (json === undefined) return undefined
    return JSON.parse(json) as PersistedHistoryLog
  } catch {
    return undefined
  }
}

/** 无盘宿主与契约测试使用的日志 driver；每个工厂实例彼此隔离。 */
export function createMemoryHistoryLogDriver(): HistoryLogDriver {
  const logs = new Map<string, PersistedHistoryLog>()
  return {
    async load(sessionId) {
      return logs.get(sessionId)
    },
    async save(sessionId, log) {
      logs.set(sessionId, log)
    },
    async deleteSession(sessionId) {
      logs.delete(sessionId)
    },
  }
}
