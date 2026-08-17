// 持久化 driver 写入的性能诊断包装。

import type { SessionMeta, WorkspaceMeta } from '../state/core.type'
import type { Checkpoint } from '../state/checkpoint.type'
import type { SessionsPersistence } from '../state/persistence/contract'
import type { HistoryDriver } from '../state/persistence/historyDriver'
import type { ObservabilityPort } from '../observability/port'

export interface PersistenceDiagnosticContext {
  operationId?: string
  reason?: string
  sessionId?: string
  runId?: string
}

export function writeSessions(
  driver: SessionsPersistence,
  snapshot: SessionMeta[],
  context: PersistenceDiagnosticContext,
  queuedAt: number,
  queueDepthAtEnqueue: number,
  coalescedCalls: number,
  observability: ObservabilityPort,
): Promise<void> {
  const operation = observability.beginPerformanceDiagnostic(
    'persistence.sessions.write',
    {
      ...context,
      queueDepthAtEnqueue,
      coalescedCalls,
      sessionCount: snapshot.length,
    },
    { slowMs: 100, operationId: context.operationId },
  )
  const startedAt = observability.performanceNow()
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
        driverWaitMs: observability.performanceNow() - startedAt,
      },
      error,
    )
    return Promise.reject(error)
  }
  void write.then(
    () => {
      operation.finish('ok', {
        queueWaitMs: startedAt - queuedAt,
        driverWaitMs: observability.performanceNow() - startedAt,
      })
    },
    (error) => {
      operation.finish(
        'error',
        {
          queueWaitMs: startedAt - queuedAt,
          driverWaitMs: observability.performanceNow() - startedAt,
        },
        error,
      )
    },
  )
  return write
}

export function writeWorkspaces(
  driver: SessionsPersistence,
  snapshot: WorkspaceMeta[],
  queuedAt: number,
  queueDepthAtEnqueue: number,
  observability: ObservabilityPort,
): Promise<void> {
  const operation = observability.beginPerformanceDiagnostic(
    'persistence.workspaces.write',
    { queueDepthAtEnqueue, workspaceCount: snapshot.length },
    { slowMs: 100 },
  )
  const startedAt = observability.performanceNow()
  let write: Promise<void>
  try {
    write = driver.saveWorkspaces(snapshot)
  } catch (error) {
    operation.finish(
      'error',
      {
        queueWaitMs: startedAt - queuedAt,
        driverWaitMs: observability.performanceNow() - startedAt,
      },
      error,
    )
    return Promise.reject(error)
  }
  void write.then(
    () => {
      operation.finish('ok', {
        queueWaitMs: startedAt - queuedAt,
        driverWaitMs: observability.performanceNow() - startedAt,
      })
    },
    (error) => {
      operation.finish(
        'error',
        {
          queueWaitMs: startedAt - queuedAt,
          driverWaitMs: observability.performanceNow() - startedAt,
        },
        error,
      )
    },
  )
  return write
}

export function writeCheckpoint(
  driver: HistoryDriver,
  id: string,
  checkpoint: Checkpoint,
  queuedAt: number,
  queueDepthAtEnqueue: number,
  observability: ObservabilityPort,
): Promise<void> {
  const operation = observability.beginPerformanceDiagnostic(
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
  const startedAt = observability.performanceNow()
  let write: Promise<void>
  try {
    write = driver.saveCheckpoint(id, checkpoint)
  } catch (error) {
    operation.finish(
      'error',
      {
        queueWaitMs: startedAt - queuedAt,
        driverWaitMs: observability.performanceNow() - startedAt,
      },
      error,
    )
    return Promise.reject(error)
  }
  void write.then(
    () => {
      operation.finish('ok', {
        queueWaitMs: startedAt - queuedAt,
        driverWaitMs: observability.performanceNow() - startedAt,
      })
    },
    (error) => {
      operation.finish(
        'error',
        {
          queueWaitMs: startedAt - queuedAt,
          driverWaitMs: observability.performanceNow() - startedAt,
        },
        error,
      )
    },
  )
  return write
}
