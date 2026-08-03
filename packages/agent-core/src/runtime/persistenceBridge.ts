// D-4 · 持久化接线桥 —— runtime 写路径 ↔ 持久化 driver 之间的 fire-and-forget 钩子（§4 D-4 / §1 DK2）。
// ---------------------------------------------------------------------------
// 背景：持久化件（IndexedDB HistoryDriver / sessions 存储 / hydrate）已齐，但 runtime 里
//   没有落盘调用。本文只做「接线」：把 commands / modelRun 的写事件转成 driver 调用。
//   · DK2 fire-and-forget：写盘绝不卡 UI —— 每个钩子都同步返回 void，内部 `void ...catch(()=>{})`
//     把落盘扔进微任务队列、吞掉任何错误（对齐 driver 自身的 best-effort 降级契约）。
//   · driver 注入（兼顾可测）：main.tsx 启动时 configurePersistence 注入真 driver 实例；
//     未配置（undefined）时全部 no-op、不抛 —— 因此 commands/modelRun 的既有单测无需配置即保持绿。
//   本文不 import UI，也不持有 store 引用（persistSessions 内部自取 rootStore，对齐 U2）。

import { rootStore, sessionsAtom, workspacesAtom } from '../state/rootStore'
import type { SessionMeta, WorkspaceMeta } from '../state/core.type'
import type { Checkpoint } from '../state/checkpoint.type'
import type { SessionsPersistence } from '../state/persistence/contract'
import type { HistoryDriver } from '../state/persistence/historyDriver'
import {
  beginPerformanceDiagnostic,
  performanceNow,
} from '../observability/performanceDiagnostics'
import { createWriteQueue } from './writeQueue'

// ===========================================================================
// 模块级 driver 注入 —— 未配置时全部 no-op
// ===========================================================================

let history: HistoryDriver | undefined
let sessions: SessionsPersistence | undefined
const sessionsWriteQueue = createWriteQueue('latest')
const workspacesWriteQueue = createWriteQueue('serial')
const historyWriteQueue = createWriteQueue('serial')

export interface PersistenceDiagnosticContext {
  operationId?: string
  reason?: string
  sessionId?: string
  runId?: string
}

// 简介：注入/更新持久化 driver（HistoryDriver + 会话列表存储）。
// 详情：浅合并，只覆盖传入的字段；未传的保持原值。main.tsx 用与 hydrate 相同的一对实例注入。
export function configurePersistence(deps: {
  history?: HistoryDriver
  sessions?: SessionsPersistence
}): void {
  if (deps.history !== undefined) history = deps.history
  if (deps.sessions !== undefined) sessions = deps.sessions
}

// 简介：复位注入（仅测试用）——把两个 driver 置回 undefined，隔离用例之间的模块级状态。
export function resetPersistence(): void {
  history = undefined
  sessions = undefined
  sessionsWriteQueue.reset()
  workspacesWriteQueue.reset()
  historyWriteQueue.reset()
}

// ===========================================================================
// fire-and-forget 落盘钩子 —— 未配置全部 no-op、绝不抛（DK2）
// ===========================================================================

// 简介：把当前会话列表覆盖式落盘（会话增删改后调用）。
// 详情：取 rootStore.sessionsAtom 全部 SessionMeta 交给 saveSessions；未配置则 `?.` 短路成 no-op。
export function persistSessions(context: PersistenceDiagnosticContext = {}): void {
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

function writeSessions(
  driver: SessionsPersistence,
  snapshot: SessionMeta[],
  context: PersistenceDiagnosticContext,
  queuedAt: number,
  queueDepthAtEnqueue: number,
  coalescedCalls: number,
): Promise<void> {
  const planCount = snapshot.reduce((count, session) => count + (session.plan ? 1 : 0), 0)
  const executionNodeCount = snapshot.reduce(
    (count, session) => count + (session.executionGraph?.order.length ?? 0),
    0,
  )
  const operation = beginPerformanceDiagnostic(
    'persistence.sessions.write',
    {
      ...context,
      queueDepthAtEnqueue,
      coalescedCalls,
      sessionCount: snapshot.length,
      planCount,
      executionNodeCount,
    },
    { slowMs: 100, operationId: context.operationId },
  )
  const startedAt = performanceNow()

  let write: Promise<void>
  try {
    write = context.operationId === undefined
      ? driver.saveSessions(snapshot)
      : driver.saveSessions(snapshot, context.operationId)
  } catch (error) {
    operation.finish(
      'error',
      {
        queueWaitMs: startedAt - queuedAt,
        driverWaitMs: performanceNow() - startedAt,
      },
      error,
    )
    return Promise.reject(error)
  }

  void write.then(
    () => {
      operation.finish('ok', {
        queueWaitMs: startedAt - queuedAt,
        driverWaitMs: performanceNow() - startedAt,
      })
    },
    (error) => {
      operation.finish(
        'error',
        {
          queueWaitMs: startedAt - queuedAt,
          driverWaitMs: performanceNow() - startedAt,
        },
        error,
      )
    },
  )
  return write
}

// 简介：把一级工作区登记表覆盖式落盘。
export function persistWorkspaces(): void {
  const driver = sessions
  if (!driver) return
  const snapshot = Object.values(rootStore.getter(workspacesAtom))
  const queuedAt = performanceNow()
  workspacesWriteQueue.enqueue('workspaces', ({ queueDepthAtEnqueue }) =>
    writeWorkspaces(driver, snapshot, queuedAt, queueDepthAtEnqueue),
  )
}

function writeWorkspaces(
  driver: SessionsPersistence,
  snapshot: WorkspaceMeta[],
  queuedAt: number,
  queueDepthAtEnqueue: number,
): Promise<void> {
  const operation = beginPerformanceDiagnostic(
    'persistence.workspaces.write',
    { queueDepthAtEnqueue, workspaceCount: snapshot.length },
    { slowMs: 100 },
  )
  const startedAt = performanceNow()
  let write: Promise<void>
  try {
    write = driver.saveWorkspaces(snapshot)
  } catch (error) {
    operation.finish(
      'error',
      {
        queueWaitMs: startedAt - queuedAt,
        driverWaitMs: performanceNow() - startedAt,
      },
      error,
    )
    return Promise.reject(error)
  }
  void write.then(
    () => {
      operation.finish('ok', {
        queueWaitMs: startedAt - queuedAt,
        driverWaitMs: performanceNow() - startedAt,
      })
    },
    (error) => {
      operation.finish(
        'error',
        {
          queueWaitMs: startedAt - queuedAt,
          driverWaitMs: performanceNow() - startedAt,
        },
        error,
      )
    },
  )
  return write
}

// 简介：把某会话刚提交的一轮 checkpoint 落盘（commitCheckpoint 之后调用）。
export function persistCheckpoint(id: string, checkpoint: Checkpoint): void {
  const driver = history
  if (!driver) return
  const queuedAt = performanceNow()
  historyWriteQueue.enqueue(id, ({ queueDepthAtEnqueue }) =>
    writeCheckpoint(driver, id, checkpoint, queuedAt, queueDepthAtEnqueue),
  )
}

function writeCheckpoint(
  driver: HistoryDriver,
  id: string,
  checkpoint: Checkpoint,
  queuedAt: number,
  queueDepthAtEnqueue: number,
): Promise<void> {
  const operation = beginPerformanceDiagnostic(
    'persistence.checkpoint.write',
    {
      sessionId: id,
      turnIndex: checkpoint.turnIndex,
      itemCount: checkpoint.items.length,
      hasPlan: checkpoint.plan !== undefined,
      queueDepthAtEnqueue,
    },
    { slowMs: 100 },
  )
  const startedAt = performanceNow()
  let write: Promise<void>
  try {
    write = driver.saveCheckpoint(id, checkpoint)
  } catch (error) {
    operation.finish(
      'error',
      {
        queueWaitMs: startedAt - queuedAt,
        driverWaitMs: performanceNow() - startedAt,
      },
      error,
    )
    return Promise.reject(error)
  }
  void write.then(
    () => {
      operation.finish('ok', {
        queueWaitMs: startedAt - queuedAt,
        driverWaitMs: performanceNow() - startedAt,
      })
    },
    (error) => {
      operation.finish(
        'error',
        {
          queueWaitMs: startedAt - queuedAt,
          driverWaitMs: performanceNow() - startedAt,
        },
        error,
      )
    },
  )
  return write
}

// 简介：截断某会话中 turnIndex 之后的持久化 checkpoint（回退 jumpToCheckpoint 之后调用）。
export function persistTruncate(id: string, turnIndex: number): void {
  const driver = history
  if (!driver) return
  historyWriteQueue.enqueue(id, () => driver.truncateAfter(id, turnIndex))
}

// 简介：清空某会话的全部持久化历史（removeSession 之后调用）。
export function persistDeleteSession(id: string): void {
  const driver = history
  if (!driver) return
  historyWriteQueue.enqueue(id, () => driver.deleteSession(id))
}
