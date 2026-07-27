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
import type { HistoryDriver } from '../state/persistence/historyDriver'
import {
  beginPerformanceDiagnostic,
  performanceNow,
} from '../observability/performanceDiagnostics'

// 会话列表持久化器的结构（对应 createSessionsPersistence 的返回形状）；接线只用到 saveSessions。
interface SessionsPersistence {
  saveSessions(sessions: SessionMeta[], diagnosticOperationId?: string): Promise<void>
  loadSessions(): Promise<SessionMeta[]>
  saveWorkspaces?(workspaces: WorkspaceMeta[]): Promise<void>
  loadWorkspaces?(): Promise<WorkspaceMeta[]>
}

// ===========================================================================
// 模块级 driver 注入 —— 未配置时全部 no-op
// ===========================================================================

let history: HistoryDriver | undefined
let sessions: SessionsPersistence | undefined
const checkpointWriteTails = new Map<string, Promise<void>>()
const checkpointWriteDepths = new Map<string, number>()
let workspacesWriteTail: Promise<void> | undefined
let sessionsWriteDepth = 0
let workspacesWriteDepth = 0
let sessionsWriteActive = false
let pendingSessionsWrite: SessionsWriteRequest | undefined
let sessionsWriteGeneration = 0

export interface PersistenceDiagnosticContext {
  operationId?: string
  reason?: string
  sessionId?: string
  runId?: string
}

interface SessionsWriteRequest {
  driver: SessionsPersistence
  snapshot: SessionMeta[]
  context: PersistenceDiagnosticContext
  queuedAt: number
  queueDepthAtEnqueue: number
  coalescedCalls: number
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
  checkpointWriteTails.clear()
  checkpointWriteDepths.clear()
  workspacesWriteTail = undefined
  sessionsWriteGeneration += 1
  sessionsWriteActive = false
  pendingSessionsWrite = undefined
  sessionsWriteDepth = 0
  workspacesWriteDepth = 0
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
  const request: SessionsWriteRequest = {
    driver,
    snapshot,
    context,
    queuedAt,
    queueDepthAtEnqueue: sessionsWriteActive ? 2 : 1,
    coalescedCalls: 0,
  }

  if (sessionsWriteActive) {
    request.coalescedCalls = (pendingSessionsWrite?.coalescedCalls ?? 0) + 1
    pendingSessionsWrite = request
    sessionsWriteDepth = 2
    return
  }

  sessionsWriteActive = true
  sessionsWriteDepth = 1
  runSessionsWrite(request, sessionsWriteGeneration)
}

function runSessionsWrite(request: SessionsWriteRequest, generation: number): void {
  const { context, driver, snapshot } = request
  const planCount = snapshot.reduce((count, session) => count + (session.plan ? 1 : 0), 0)
  const executionNodeCount = snapshot.reduce(
    (count, session) => count + (session.executionGraph?.order.length ?? 0),
    0,
  )
  const operation = beginPerformanceDiagnostic(
    'persistence.sessions.write',
    {
      ...context,
      queueDepthAtEnqueue: request.queueDepthAtEnqueue,
      coalescedCalls: request.coalescedCalls,
      sessionCount: snapshot.length,
      planCount,
      executionNodeCount,
    },
    { slowMs: 100, operationId: context.operationId },
  )
  const startedAt = performanceNow()

  const complete = (): void => {
    if (generation !== sessionsWriteGeneration) return
    const next = pendingSessionsWrite
    pendingSessionsWrite = undefined
    if (next) {
      sessionsWriteDepth = 1
      runSessionsWrite(next, generation)
      return
    }
    sessionsWriteDepth = 0
    sessionsWriteActive = false
  }

  let write: Promise<void>
  try {
    write = context.operationId === undefined
      ? driver.saveSessions(snapshot)
      : driver.saveSessions(snapshot, context.operationId)
  } catch (error) {
    operation.finish(
      'error',
      {
        queueWaitMs: startedAt - request.queuedAt,
        driverWaitMs: performanceNow() - startedAt,
      },
      error,
    )
    complete()
    return
  }

  void write.then(
    () => {
      operation.finish('ok', {
        queueWaitMs: startedAt - request.queuedAt,
        driverWaitMs: performanceNow() - startedAt,
      })
      complete()
    },
    (error) => {
      operation.finish(
        'error',
        {
          queueWaitMs: startedAt - request.queuedAt,
          driverWaitMs: performanceNow() - startedAt,
        },
        error,
      )
      complete()
    },
  )
}

// 简介：把一级工作区登记表覆盖式落盘；旧 driver 未实现该方法时安全降级为 no-op。
export function persistWorkspaces(): void {
  const driver = sessions
  if (!driver?.saveWorkspaces) return
  const snapshot = Object.values(rootStore.getter(workspacesAtom))
  const queuedAt = performanceNow()
  const queueDepthAtEnqueue = ++workspacesWriteDepth
  const runWrite = (): Promise<void> => {
    const operation = beginPerformanceDiagnostic(
      'persistence.workspaces.write',
      { queueDepthAtEnqueue, workspaceCount: snapshot.length },
      { slowMs: 100 },
    )
    const startedAt = performanceNow()
    let write: Promise<void>
    try {
      write = driver.saveWorkspaces!(snapshot)
    } catch (error) {
      operation.finish(
        'error',
        {
          queueWaitMs: startedAt - queuedAt,
          driverWaitMs: performanceNow() - startedAt,
        },
        error,
      )
      workspacesWriteDepth = Math.max(0, workspacesWriteDepth - 1)
      return Promise.reject(error)
    }
    void write.then(
      () => {
        operation.finish('ok', {
          queueWaitMs: startedAt - queuedAt,
          driverWaitMs: performanceNow() - startedAt,
        })
        workspacesWriteDepth = Math.max(0, workspacesWriteDepth - 1)
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
        workspacesWriteDepth = Math.max(0, workspacesWriteDepth - 1)
      },
    )
    return write
  }
  const write = workspacesWriteTail
    ? workspacesWriteTail.then(runWrite)
    : runWrite()
  const settled = write.catch(() => {})
  workspacesWriteTail = settled
  void settled.finally(() => {
    if (workspacesWriteTail === settled) workspacesWriteTail = undefined
  })
}

// 简介：把某会话刚提交的一轮 checkpoint 落盘（commitCheckpoint 之后调用）。
export function persistCheckpoint(id: string, checkpoint: Checkpoint): void {
  const driver = history
  if (!driver) return
  const previous = checkpointWriteTails.get(id)
  const queuedAt = performanceNow()
  const queueDepthAtEnqueue = (checkpointWriteDepths.get(id) ?? 0) + 1
  checkpointWriteDepths.set(id, queueDepthAtEnqueue)
  const runWrite = (): Promise<void> => {
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
      const remaining = Math.max(0, (checkpointWriteDepths.get(id) ?? 1) - 1)
      if (remaining === 0) checkpointWriteDepths.delete(id)
      else checkpointWriteDepths.set(id, remaining)
      return Promise.reject(error)
    }
    void write.then(
      () => {
        operation.finish('ok', {
          queueWaitMs: startedAt - queuedAt,
          driverWaitMs: performanceNow() - startedAt,
        })
        const remaining = Math.max(0, (checkpointWriteDepths.get(id) ?? 1) - 1)
        if (remaining === 0) checkpointWriteDepths.delete(id)
        else checkpointWriteDepths.set(id, remaining)
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
        const remaining = Math.max(0, (checkpointWriteDepths.get(id) ?? 1) - 1)
        if (remaining === 0) checkpointWriteDepths.delete(id)
        else checkpointWriteDepths.set(id, remaining)
      },
    )
    return write
  }
  const write = previous
    ? previous.then(runWrite)
    : runWrite()
  const settled = write.catch(() => {})
  checkpointWriteTails.set(id, settled)
  void settled.finally(() => {
    if (checkpointWriteTails.get(id) === settled) checkpointWriteTails.delete(id)
  })
}

// 简介：截断某会话中 turnIndex 之后的持久化 checkpoint（回退 jumpToCheckpoint 之后调用）。
export function persistTruncate(id: string, turnIndex: number): void {
  void history?.truncateAfter(id, turnIndex).catch(() => {})
}

// 简介：清空某会话的全部持久化历史（removeSession 之后调用）。
export function persistDeleteSession(id: string): void {
  void history?.deleteSession(id).catch(() => {})
}
