// 恢复快照的启动期判定：只接受完整的 v1 投影。

import { decodeRecoverySnapshot } from '../recoverySnapshot.codec'
import type { SessionMeta } from '../core.type'
import type { RecoverySnapshotV1 } from '../recoverySnapshot.type'
import { reduceExecutionGraph } from '../../execution/graph'
import { projectStaticSessionMeta } from '../sessionMetaProjection'
import type { RecoveryDriver } from './recoveryDriver'

export interface RecoveryHydrationPlan {
  /** 已用恢复记录中静态 session meta 替换、并补齐遗失 root session 的登记表。 */
  sessionMetas: SessionMeta[]
  /** 每项均已通过 codec；调用方必须用 R2 的单批投影写入。 */
  snapshotsBySessionId: ReadonlyMap<string, RecoverySnapshotV1>
}

function decodeForSession(value: unknown, sessionId?: string): RecoverySnapshotV1 | undefined {
  try {
    const snapshot = decodeRecoverySnapshot(value)
    return snapshot && (sessionId === undefined || snapshot.sessionId === sessionId)
      ? snapshot
      : undefined
  } catch {
    return undefined
  }
}

async function readRecovery(
  recovery: RecoveryDriver,
  sessionId: string,
): Promise<RecoverySnapshotV1 | undefined> {
  try {
    const candidate = await recovery.loadLatest(sessionId)
    return candidate === undefined ? undefined : decodeForSession(candidate, sessionId)
  } catch {
    return undefined
  }
}

async function listRecovery(
  recovery: RecoveryDriver,
): Promise<Map<string, RecoverySnapshotV1>> {
  const snapshots = new Map<string, RecoverySnapshotV1>()
  try {
    const candidates: unknown[] = await recovery.listLatest()
    for (const candidate of candidates) {
      const snapshot = decodeForSession(candidate)
      if (!snapshot || snapshots.has(snapshot.sessionId)) continue
      snapshots.set(snapshot.sessionId, snapshot)
    }
  } catch {
    // 已登记 session 仍会逐一 loadLatest；无法枚举的陌生记录不能安全地注册进 root。
  }
  return snapshots
}

function staticSessionMeta(snapshot: RecoverySnapshotV1): SessionMeta {
  return projectStaticSessionMeta(snapshot.session)
}

/** 将会被终止进程遗留的运行态归类为可显式继续的 interrupted。 */
export function normalizeRecoverySnapshotForHydration(
  snapshot: RecoverySnapshotV1,
): RecoverySnapshotV1 {
  const run = snapshot.values.run
  const normalizedRun = run && (run.status === 'running' || run.status === 'awaiting_tool' || run.status === 'interrupted')
    ? { ...run, status: 'interrupted' as const }
    : run
  // Graph nodes can represent work that was live in a process that no longer
  // exists. Reuse the execution reducer so queued/ready/running/waiting nodes
  // receive the same interruption semantics as any other hydrated graph.
  const normalizedGraph = reduceExecutionGraph(
    snapshot.values.executionGraph,
    { type: 'graph.hydrated', at: Date.now() },
  )
  if (normalizedRun === run && normalizedGraph === snapshot.values.executionGraph) return snapshot
  return {
    ...snapshot,
    values: {
      ...snapshot.values,
      // pendingExecutionId is excluded during capture because it is process-local.
      run: normalizedRun,
      executionGraph: normalizedGraph,
    },
  }
}

/**
 * 读取每个会话的 v1 恢复代，并从 listLatest 补回 root 登记表丢失的 session。
 * 无法读取或解码的 v1 记录不产生运行态投影。
 */
export async function prepareRecoveryHydration(
  recovery: RecoveryDriver | undefined,
  persistedSessions: SessionMeta[],
): Promise<RecoveryHydrationPlan> {
  if (!recovery) {
    return {
      sessionMetas: persistedSessions.map(projectStaticSessionMeta),
      snapshotsBySessionId: new Map(),
    }
  }

  const [listed, reads] = await Promise.all([
    listRecovery(recovery),
    Promise.all(persistedSessions.map(async (session) => [session.id, await readRecovery(recovery, session.id)] as const)),
  ])
  // listLatest may recover sessions missing from the root registry.  For a
  // registered session, its direct V1 read is authoritative: absent, corrupt,
  // or unreadable means no live recovery projection.
  const snapshots = new Map(listed)
  for (const [sessionId, snapshot] of reads) {
    if (snapshot) snapshots.set(sessionId, snapshot)
    else snapshots.delete(sessionId)
  }

  const known = new Set(persistedSessions.map((session) => session.id))
  const sessionMetas = persistedSessions.map((session) => {
    const snapshot = snapshots.get(session.id)
    if (snapshot) return staticSessionMeta(snapshot)
    return projectStaticSessionMeta(session)
  })
  for (const [sessionId, snapshot] of snapshots) {
    if (!known.has(sessionId)) sessionMetas.push(staticSessionMeta(snapshot))
  }

  return {
    sessionMetas,
    snapshotsBySessionId: snapshots,
  }
}
