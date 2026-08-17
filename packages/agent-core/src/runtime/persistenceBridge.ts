// D-4 · 持久化接线桥 —— runtime 写路径 ↔ 持久化 driver 之间的 fire-and-forget 钩子（§4 D-4 / §1 DK2）。
// ---------------------------------------------------------------------------
// 背景：持久化件（sessions 存储 / recovery driver / hydrate）已齐，但 runtime 里
//   没有落盘调用。本文只做「接线」：把 commands / modelRun 的写事件转成 driver 调用。
//   · history / sessions 遵循 DK2 fire-and-forget：写盘绝不卡 UI，队列内部自行处理其 best-effort 失败。
//   · recovery 例外：仍由显式 facade 异步触发，但 RecoveryWriter 以 outcome 与 observability diagnostic
//     公开 driver 失败，不能把它表述成统一吞掉。
//   · driver 注入（兼顾可测）：main.tsx 启动时 configurePersistence 注入真 driver 实例；
//     未配置（undefined）时全部 no-op、不抛 —— 因此 commands/modelRun 的既有单测无需配置即保持绿。
//   本文不 import UI；每个 CoreInstance 把自己的 rootStore 注入一个 bridge 实例。

import type { History, Store } from '@einfach/core'
import { sessionsAtom, workspacesAtom } from '../state/rootAtoms'
import type { SessionsPersistence } from '../state/persistence/contract'
import type { RecoveryDriver } from '../state/persistence/recoveryDriver'
import {
  toPersistableHistoryLog,
  type HistoryLogDriver,
} from '../state/persistence/historyLogDriver'
import { projectStaticSessionMeta } from '../state/sessionMetaProjection'
import type { ObservabilityPort } from '../observability/port'
import {
  createRecoveryWriter,
  type RecoveryWriter,
  type RecoveryWriteOutcome,
} from './recoveryWriter'
import { createWriteQueue } from './writeQueue'
import {
  writeSessions,
  writeWorkspaces,
  type PersistenceDiagnosticContext,
} from './persistenceWriteOperations'

export type { PersistenceDiagnosticContext } from './persistenceWriteOperations'

// ===========================================================================
// Per-core bridge：driver、写队列和 rootStore 快照必须同属一个 CoreInstance。
// ===========================================================================

export interface PersistenceDependencies {
  sessions?: SessionsPersistence
  recovery?: RecoveryDriver
  /** Must only return an extant session store; recovery persistence never creates a session. */
  recoveryStore?: (sessionId: string) => Store | undefined
  /** 撤销日志的落盘 driver；与 recovery 成对刷盘（见 state/persistence/historyLogDriver.ts）。 */
  historyLog?: HistoryLogDriver
  /** 同 recoveryStore 的纪律：只允许返回已存在的会话日志，绝不因落盘而创建会话。 */
  historyFor?: (sessionId: string) => History | undefined
}

export interface PersistenceBridge {
  configure(deps: PersistenceDependencies): void
  /** 回读本实例当前配置的 driver 对（启动读回要用同一对，别再由宿主手拼）。 */
  dependencies(): PersistenceDependencies
  reset(): void
  persistSessions(context?: PersistenceDiagnosticContext): void
  persistWorkspaces(): void
  persistDeleteSession(id: string): void
  /** Explicit recovery boundary; no atom subscription is installed by this bridge. */
  persistRecovery(id: string, reason?: string): Promise<RecoveryWriteOutcome | undefined>
  /** Waits for recovery writes queued before this call, for orderly shutdown or dispose. */
  flushRecovery(): Promise<void>
  /** Hydrates this Core instance's stores from its configured persistence drivers. */
  hydrate(): Promise<boolean>
}

/**
 * Creates the persistence resources owned by one CoreInstance.
 *
 * `hydrateSession` 给的是整个会话槽（store + 日志），不只是 store：读回一个会话要同时铺状态
 * 和它的撤销日志，而两者必须来自同一个会话槽实例。它按需创建会话（hydrate 本就在建会话），
 * 与 `recoveryStore` / `historyFor`「只返回已存在的」是相反的纪律，故是两个入口。
 */
export function createPersistenceBridge(
  rootStore: Store,
  observability: ObservabilityPort,
  hydrateSession?: (sessionId: string) => { store: Store; history: History },
): PersistenceBridge {
  let sessions: SessionsPersistence | undefined
  let recovery: RecoveryDriver | undefined
  let recoveryStore: ((sessionId: string) => Store | undefined) | undefined
  let historyLog: HistoryLogDriver | undefined
  let historyFor: ((sessionId: string) => History | undefined) | undefined
  let recoveryWriter: RecoveryWriter | undefined
  const sessionsWriteQueue = createWriteQueue('latest')
  const workspacesWriteQueue = createWriteQueue('serial')

  function configure(deps: PersistenceDependencies): void {
    if (deps.sessions !== undefined) sessions = deps.sessions
    if (deps.recovery !== undefined) recovery = deps.recovery
    if (deps.recoveryStore !== undefined) recoveryStore = deps.recoveryStore
    if (deps.historyLog !== undefined) historyLog = deps.historyLog
    if (deps.historyFor !== undefined) historyFor = deps.historyFor
    if (deps.recovery !== undefined || deps.recoveryStore !== undefined) {
      recoveryWriter?.reset()
      recoveryWriter = recovery && recoveryStore
        ? createRecoveryWriter({ rootStore, recovery, observability })
        : undefined
    }
  }

  function dependencies(): PersistenceDependencies {
    return { sessions, recovery, recoveryStore, historyLog, historyFor }
  }

  function reset(): void {
    sessions = undefined
    recovery = undefined
    recoveryStore = undefined
    historyLog = undefined
    historyFor = undefined
    recoveryWriter?.reset()
    recoveryWriter = undefined
    sessionsWriteQueue.reset()
    workspacesWriteQueue.reset()
  }

  // 简介：把当前会话列表覆盖式落盘（会话增删改后调用）。
  // 详情：取本实例 rootStore.sessionsAtom 全部 SessionMeta 交给 saveSessions；未配置则 no-op。
  function persistSessions(context: PersistenceDiagnosticContext = {}): void {
    const driver = sessions
    if (!driver) return
    // Capture the newest full snapshot, but keep at most one pending overwrite.
    // Execution nodes can emit queued → running → terminal in a few milliseconds;
    // serializing every 1MB+ intermediate snapshot makes the UI appear frozen.
    const snapshot = Object.values(rootStore.getter(sessionsAtom)).map(projectStaticSessionMeta)
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

  // 简介：清空某会话的全部持久化恢复记录（removeSession 之后调用）。
  function persistDeleteSession(id: string): void {
    if (recoveryWriter) void recoveryWriter.deleteSession(id)
    // 日志跟着会话一起走。不留 tombstone：它不是真相，快照那侧已经永久 fence 住这个 id。
    if (historyLog) void historyLog.deleteSession(id).catch(() => undefined)
  }

  /**
   * 把某会话的撤销日志与刚落盘的那份快照配对存下。
   *
   * 只在快照真的写成功（`saved`）时才刷：`stale` / `tombstoned` / `error` 都意味着盘上的快照
   * 不是这次这份，配上去的 generation 就是假的对应关系。读回时宁可发现 generation 不匹配而
   * 丢掉整份日志（撤销不可用、状态仍对），也不要让一份错配的日志被当成可信的。
   *
   * fire-and-forget：日志不是真相，落盘失败不该影响栅栏的结论，也不该拖慢它。
   */
  function flushHistoryLog(outcome: RecoveryWriteOutcome | undefined, id: string): void {
    if (outcome?.status !== 'saved') return
    const driver = historyLog
    const history = historyFor?.(id)
    if (!driver || !history) return
    const log = toPersistableHistoryLog(outcome.generation, history.getState())
    // 不可序列化 = 某个槽位的记账载荷里塞了类实例/闭包。丢掉这一份而不是写半份进去。
    if (!log) return
    void driver.save(id, log).catch(() => undefined)
  }

  function persistRecovery(id: string, reason?: string): Promise<RecoveryWriteOutcome | undefined> {
    const writer = recoveryWriter
    if (!writer) return Promise.resolve(undefined)
    const store = recoveryStore?.(id)
    if (!store) return Promise.resolve(undefined)
    return writer.persist(store, id, reason).then((outcome) => {
      flushHistoryLog(outcome, id)
      return outcome
    })
  }

  function flushRecovery(): Promise<void> {
    return recoveryWriter?.flush() ?? Promise.resolve()
  }

  async function hydrate(): Promise<boolean> {
    const { sessions, recovery, historyLog } = dependencies()
    if (!sessions || !hydrateSession) return false

    const { hydrateForCore } = await import('../state/persistence/hydrate')
    return hydrateForCore(
      {
        rootStore,
        getSessionStore: (sessionId) => hydrateSession(sessionId).store,
        getSessionHistory: (sessionId) => hydrateSession(sessionId).history,
      },
      { sessions, recovery, historyLog },
    )
  }

  return {
    configure,
    dependencies,
    reset,
    persistSessions,
    persistWorkspaces,
    persistDeleteSession,
    persistRecovery,
    flushRecovery,
    hydrate,
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
//   · 默认 facade 委托 defaultCore 自己的 bridge；其它 Core 应直接调用 core.persistence.hydrate()。
//     每一个 bridge 闭包绑定自己的 rootStore 和会话 store locator，不会触及 defaultCore。
//   · hydrate 走【动态 import】：静态 import 会连出
//     persistenceBridge → hydrate → state/rootStore → core/coreInstance → persistenceBridge
//     这个初始化期循环（coreInstance 模块顶层就调 setDefaultPersistenceBridge，撞上本模块
//     defaultBridgeRef 的 TDZ）。推到调用时刻加载即可绕开，且它本就在启动关键路径上。
//   · driver 未配置 → 直接 false（与 hydrate 自身「失败不阻塞启动」的容错契约一致）。
export function hydratePersistence(): Promise<boolean> {
  return defaultBridgeRef.current?.hydrate() ?? Promise.resolve(false)
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

export function persistDeleteSession(id: string): void {
  defaultBridgeRef.current?.persistDeleteSession(id)
}

export function persistRecovery(id: string, reason?: string): Promise<RecoveryWriteOutcome | undefined> {
  return defaultBridgeRef.current?.persistRecovery(id, reason) ?? Promise.resolve(undefined)
}

/** Waits for recovery writes already queued on the default Core instance. */
export function flushRecovery(): Promise<void> {
  return defaultBridgeRef.current?.flushRecovery() ?? Promise.resolve()
}
