// D-4 · 持久化接线桥 —— runtime 写路径 ↔ 持久化 driver 之间的 fire-and-forget 钩子（§4 D-4 / §1 DK2）。
// ---------------------------------------------------------------------------
// 背景：持久化件（IndexedDB HistoryDriver / sessions 存储 / hydrate）已齐，但 runtime 里
//   没有落盘调用。本文只做「接线」：把 commands / modelRun 的写事件转成 driver 调用。
//   · DK2 fire-and-forget：写盘绝不卡 UI —— 每个钩子都同步返回 void，内部 `void ...catch(()=>{})`
//     把落盘扔进微任务队列、吞掉任何错误（对齐 driver 自身的 best-effort 降级契约）。
//   · driver 注入（兼顾可测）：main.tsx 启动时 configurePersistence 注入真 driver 实例；
//     未配置（undefined）时全部 no-op、不抛 —— 因此 commands/modelRun 的既有单测无需配置即保持绿。
//   本文不 import UI；每个 CoreInstance 把自己的 rootStore 注入一个 bridge 实例。

import type { Store } from '@einfach/core'
import { sessionsAtom, workspacesAtom } from '../state/rootAtoms'
import type { Checkpoint } from '../state/checkpoint.type'
import type { SessionsPersistence } from '../state/persistence/contract'
import type { HistoryDriver } from '../state/persistence/historyDriver'
import { performanceNow } from '../observability/performanceDiagnostics'
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
}

export interface PersistenceBridge {
  configure(deps: PersistenceDependencies): void
  reset(): void
  persistSessions(context?: PersistenceDiagnosticContext): void
  persistWorkspaces(): void
  persistCheckpoint(id: string, checkpoint: Checkpoint): void
  persistTruncate(id: string, turnIndex: number): void
  persistDeleteSession(id: string): void
}

/** Creates the persistence resources owned by one CoreInstance. */
export function createPersistenceBridge(rootStore: Store): PersistenceBridge {
  let history: HistoryDriver | undefined
  let sessions: SessionsPersistence | undefined
  const sessionsWriteQueue = createWriteQueue('latest')
  const workspacesWriteQueue = createWriteQueue('serial')
  const historyWriteQueue = createWriteQueue('serial')

  function configure(deps: PersistenceDependencies): void {
    if (deps.history !== undefined) history = deps.history
    if (deps.sessions !== undefined) sessions = deps.sessions
  }

  function reset(): void {
    history = undefined
    sessions = undefined
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
    const queuedAt = performanceNow()
    sessionsWriteQueue.enqueue('sessions', ({ queueDepthAtEnqueue, coalescedCalls }) =>
      writeSessions(driver, snapshot, context, queuedAt, queueDepthAtEnqueue, coalescedCalls),
    )
  }

  // 简介：把一级工作区登记表覆盖式落盘。
  function persistWorkspaces(): void {
    const driver = sessions
    if (!driver) return
    const snapshot = Object.values(rootStore.getter(workspacesAtom))
    const queuedAt = performanceNow()
    workspacesWriteQueue.enqueue('workspaces', ({ queueDepthAtEnqueue }) =>
      writeWorkspaces(driver, snapshot, queuedAt, queueDepthAtEnqueue),
    )
  }

  // 简介：把某会话刚提交的一轮 checkpoint 落盘（commitCheckpoint 之后调用）。
  function persistCheckpoint(id: string, checkpoint: Checkpoint): void {
    const driver = history
    if (!driver) return
    const queuedAt = performanceNow()
    historyWriteQueue.enqueue(id, ({ queueDepthAtEnqueue }) =>
      writeCheckpoint(driver, id, checkpoint, queuedAt, queueDepthAtEnqueue),
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
    if (!driver) return
    historyWriteQueue.enqueue(id, () => driver.deleteSession(id))
  }

  return {
    configure,
    reset,
    persistSessions,
    persistWorkspaces,
    persistCheckpoint,
    persistTruncate,
    persistDeleteSession,
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
