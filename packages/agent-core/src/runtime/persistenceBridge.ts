// D-4 · 持久化接线桥 —— runtime 写路径 ↔ 持久化 driver 之间的 fire-and-forget 钩子（§4 D-4 / §1 DK2）。
// ---------------------------------------------------------------------------
// 背景：持久化件（IndexedDB HistoryDriver / sessions 存储 / hydrate）已齐，但 runtime 里
//   没有落盘调用。本文只做「接线」：把 commands / modelRun 的写事件转成 driver 调用。
//   · history / sessions 遵循 DK2 fire-and-forget：写盘绝不卡 UI，队列内部自行处理其 best-effort 失败。
//   · recovery 例外：仍由显式 facade 异步触发，但 RecoveryWriter 以 outcome 与 observability diagnostic
//     公开 driver 失败，不能把它表述成统一吞掉。
//   · driver 注入（兼顾可测）：main.tsx 启动时 configurePersistence 注入真 driver 实例；
//     未配置（undefined）时全部 no-op、不抛 —— 因此 commands/modelRun 的既有单测无需配置即保持绿。
//   本文不 import UI；每个 CoreInstance 把自己的 rootStore 注入一个 bridge 实例。

import type { Store } from '@einfach/core'
import { sessionsAtom, workspacesAtom } from '../state/rootAtoms'
import type { Checkpoint } from '../state/checkpoint.type'
import type { SessionsPersistence } from '../state/persistence/contract'
import type { HistoryDriver } from '../state/persistence/historyDriver'
import type { RecoveryDriver } from '../state/persistence/recoveryDriver'
import type { ObservabilityPort } from '../observability/port'
import { createRecoveryWriter, type RecoveryWriter } from './recoveryWriter'
import { createWriteQueue } from './writeQueue'
import {
  writeCheckpoint,
  writeSessions,
  writeWorkspaces,
  type PersistenceDiagnosticContext,
} from './persistenceWriteOperations'

export type { PersistenceDiagnosticContext } from './persistenceWriteOperations'

// ===========================================================================
// Per-core bridge：driver、写队列和 rootStore 快照必须同属一个 CoreInstance。
// ===========================================================================

export interface PersistenceDependencies {
  history?: HistoryDriver
  sessions?: SessionsPersistence
  recovery?: RecoveryDriver
  /** Must only return an extant session store; recovery persistence never creates a session. */
  recoveryStore?: (sessionId: string) => Store | undefined
}

export interface PersistenceBridge {
  configure(deps: PersistenceDependencies): void
  /** 回读本实例当前配置的 driver 对（启动读回要用同一对，别再由宿主手拼）。 */
  dependencies(): PersistenceDependencies
  reset(): void
  persistSessions(context?: PersistenceDiagnosticContext): void
  persistWorkspaces(): void
  persistCheckpoint(id: string, checkpoint: Checkpoint): void
  persistTruncate(id: string, turnIndex: number): void
  persistDeleteSession(id: string): void
  /** Explicit recovery boundary; no atom subscription is installed by this bridge. */
  persistRecovery(id: string, reason?: string): void
  /** Waits for recovery writes queued before this call, for orderly shutdown or dispose. */
  flushRecovery(): Promise<void>
}

/** Creates the persistence resources owned by one CoreInstance. */
export function createPersistenceBridge(rootStore: Store, observability: ObservabilityPort): PersistenceBridge {
  let history: HistoryDriver | undefined
  let sessions: SessionsPersistence | undefined
  let recovery: RecoveryDriver | undefined
  let recoveryStore: ((sessionId: string) => Store | undefined) | undefined
  let recoveryWriter: RecoveryWriter | undefined
  const sessionsWriteQueue = createWriteQueue('latest')
  const workspacesWriteQueue = createWriteQueue('serial')
  const historyWriteQueue = createWriteQueue('serial')

  function configure(deps: PersistenceDependencies): void {
    if (deps.history !== undefined) history = deps.history
    if (deps.sessions !== undefined) sessions = deps.sessions
    if (deps.recovery !== undefined) recovery = deps.recovery
    if (deps.recoveryStore !== undefined) recoveryStore = deps.recoveryStore
    if (deps.recovery !== undefined || deps.recoveryStore !== undefined) {
      recoveryWriter?.reset()
      recoveryWriter = recovery && recoveryStore
        ? createRecoveryWriter({ rootStore, recovery, observability })
        : undefined
    }
  }

  function dependencies(): PersistenceDependencies {
    return { history, sessions, recovery, recoveryStore }
  }

  function reset(): void {
    history = undefined
    sessions = undefined
    recovery = undefined
    recoveryStore = undefined
    recoveryWriter?.reset()
    recoveryWriter = undefined
    sessionsWriteQueue.reset()
    workspacesWriteQueue.reset()
    historyWriteQueue.reset()
  }

  // 简介：把当前会话列表覆盖式落盘（会话增删改后调用）。
  // 详情：取本实例 rootStore.sessionsAtom 全部 SessionMeta 交给 saveSessions；未配置则 no-op。
  function persistSessions(context: PersistenceDiagnosticContext = {}): void {
    const driver = sessions
    if (!driver) return
    // Capture the newest full snapshot, but keep at most one pending overwrite.
    // Execution nodes can emit queued → running → terminal in a few milliseconds;
    // serializing every 1MB+ intermediate snapshot makes the UI appear frozen.
    const snapshot = Object.values(rootStore.getter(sessionsAtom))
    const queuedAt = observability.performanceNow()
    sessionsWriteQueue.enqueue('sessions', ({ queueDepthAtEnqueue, coalescedCalls }) =>
      writeSessions(driver, snapshot, context, queuedAt, queueDepthAtEnqueue, coalescedCalls, observability),
    )
  }

  // 简介：把一级工作区登记表覆盖式落盘。
  function persistWorkspaces(): void {
    const driver = sessions
    if (!driver) return
    const snapshot = Object.values(rootStore.getter(workspacesAtom))
    const queuedAt = observability.performanceNow()
    workspacesWriteQueue.enqueue('workspaces', ({ queueDepthAtEnqueue }) =>
      writeWorkspaces(driver, snapshot, queuedAt, queueDepthAtEnqueue, observability),
    )
  }

  // 简介：把某会话刚提交的一轮 checkpoint 落盘（commitCheckpoint 之后调用）。
  function persistCheckpoint(id: string, checkpoint: Checkpoint): void {
    const driver = history
    if (!driver) return
    const queuedAt = observability.performanceNow()
    historyWriteQueue.enqueue(id, ({ queueDepthAtEnqueue }) =>
      writeCheckpoint(driver, id, checkpoint, queuedAt, queueDepthAtEnqueue, observability),
    )
  }

  // 简介：截断某会话中 turnIndex 之后的持久化 checkpoint（回退 jumpToCheckpoint 之后调用）。
  function persistTruncate(id: string, turnIndex: number): void {
    const driver = history
    if (!driver) return
    historyWriteQueue.enqueue(id, () => driver.truncateAfter(id, turnIndex))
  }

  // 简介：清空某会话的全部持久化历史（removeSession 之后调用）。
  function persistDeleteSession(id: string): void {
    const driver = history
    if (driver) historyWriteQueue.enqueue(id, () => driver.deleteSession(id))
    if (recoveryWriter) void recoveryWriter.deleteSession(id)
  }

  function persistRecovery(id: string, reason?: string): void {
    const writer = recoveryWriter
    if (!writer) return
    const store = recoveryStore?.(id)
    if (!store) return
    void writer.persist(store, id, reason)
  }

  function flushRecovery(): Promise<void> {
    return recoveryWriter?.flush() ?? Promise.resolve()
  }

  return {
    configure,
    dependencies,
    reset,
    persistSessions,
    persistWorkspaces,
    persistCheckpoint,
    persistTruncate,
    persistDeleteSession,
    persistRecovery,
    flushRecovery,
  }
}

// coreInstance 在创建 defaultCore 后登记它的 bridge。兼容导出因此继续服务默认实例，
// 同时本模块不反向 import coreInstance，避免初始化期循环。
const defaultBridgeRef: { current?: PersistenceBridge } = {}

export function setDefaultPersistenceBridge(bridge: PersistenceBridge): void {
  defaultBridgeRef.current = bridge
}

export function configurePersistence(deps: PersistenceDependencies): void {
  defaultBridgeRef.current?.configure(deps)
}

// 简介：启动读回 —— 用刚 configurePersistence 进来的那对 driver 把盘上的会话恢复进内存 store；
//   返回「是否恢复了任何会话」（false 时宿主该种子一个空会话）。
// 详情：这是持久化的【读】那一半，与写钩子同属本桥 —— 收在这里，宿主就不必再深挖
//   state/persistence/hydrate（盘点 E4），也不会出现「hydrate 与 configurePersistence 用了
//   两对不同实例」这种只靠注释维持的隐性约定：driver 从本桥自己的 dependencies() 取。
//   · 只服务默认实例：state/persistence/hydrate 回填的是 defaultCore 的 root/session store
//     （它 import 的是 state/rootStore 这个 defaultCore 视图），因此本函数与其他兼容导出一样
//     绑定 defaultCore，没有做成 per-instance 方法——那会对 createCore() 的隔离实例说谎。
//   · hydrate 走【动态 import】：静态 import 会连出
//     persistenceBridge → hydrate → state/rootStore → core/coreInstance → persistenceBridge
//     这个初始化期循环（coreInstance 模块顶层就调 setDefaultPersistenceBridge，撞上本模块
//     defaultBridgeRef 的 TDZ）。推到调用时刻加载即可绕开，且它本就在启动关键路径上。
//   · driver 未配置 → 直接 false（与 hydrate 自身「失败不阻塞启动」的容错契约一致）。
export async function hydratePersistence(): Promise<boolean> {
  const { history, sessions, recovery } = defaultBridgeRef.current?.dependencies() ?? {}
  if (!history || !sessions) return false
  const { hydrate } = await import('../state/persistence/hydrate')
  return hydrate({ history, sessions, recovery })
}

export function resetPersistence(): void {
  defaultBridgeRef.current?.reset()
}

export function persistSessions(context: PersistenceDiagnosticContext = {}): void {
  defaultBridgeRef.current?.persistSessions(context)
}

export function persistWorkspaces(): void {
  defaultBridgeRef.current?.persistWorkspaces()
}

export function persistCheckpoint(id: string, checkpoint: Checkpoint): void {
  defaultBridgeRef.current?.persistCheckpoint(id, checkpoint)
}

export function persistTruncate(id: string, turnIndex: number): void {
  defaultBridgeRef.current?.persistTruncate(id, turnIndex)
}

export function persistDeleteSession(id: string): void {
  defaultBridgeRef.current?.persistDeleteSession(id)
}

export function persistRecovery(id: string, reason?: string): void {
  defaultBridgeRef.current?.persistRecovery(id, reason)
}

/** Waits for recovery writes already queued on the default Core instance. */
export function flushRecovery(): Promise<void> {
  return defaultBridgeRef.current?.flushRecovery() ?? Promise.resolve()
}
