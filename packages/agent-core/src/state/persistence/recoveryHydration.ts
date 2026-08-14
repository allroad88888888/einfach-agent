// 恢复快照的启动期判定：选择 v1 投影或 legacy，绝不把两者拼接。

import { decodeRecoverySnapshot } from '../recoverySnapshot.codec'
import type { SessionMeta } from '../core.type'
import type { RecoverySnapshotV1 } from '../recoverySnapshot.type'
import type { RecoveryDriver } from './recoveryDriver'

export interface RecoveryHydrationPlan {
  /** 已用恢复记录中静态 session meta 替换、并补齐遗失 root session 的登记表。 */
  sessionMetas: SessionMeta[]
  /** 每项均已通过 codec；调用方必须用 R2 的单批投影写入。 */
  snapshotsBySessionId: ReadonlyMap<string, RecoverySnapshotV1>
  /** 记录存在却不可读/不可接受时，禁止退回 legacy 动态状态。 */
  blockedSessionIds: ReadonlySet<string>
}

type SessionRecoveryRead =
  | { state: 'absent' }
  | { state: 'ready'; snapshot: RecoverySnapshotV1 }
  | { state: 'blocked' }

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

function rejectedSessionId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const sessionId = (value as { sessionId?: unknown }).sessionId
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
}

async function readRecovery(
  recovery: RecoveryDriver,
  sessionId: string,
): Promise<SessionRecoveryRead> {
  try {
    const candidate = await recovery.loadLatest(sessionId)
    if (candidate === undefined) return { state: 'absent' }
    const snapshot = decodeForSession(candidate, sessionId)
    return snapshot ? { state: 'ready', snapshot } : { state: 'blocked' }
  } catch {
    return { state: 'blocked' }
  }
}

async function listRecovery(
  recovery: RecoveryDriver,
): Promise<{ snapshots: Map<string, RecoverySnapshotV1>; rejected: Set<string> }> {
  const snapshots = new Map<string, RecoverySnapshotV1>()
  const rejected = new Set<string>()
  try {
    const candidates: unknown[] = await recovery.listLatest()
    for (const candidate of candidates) {
      const snapshot = decodeForSession(candidate)
      if (!snapshot || snapshots.has(snapshot.sessionId)) {
        const sessionId = rejectedSessionId(candidate)
        if (sessionId) rejected.add(sessionId)
        continue
      }
      snapshots.set(snapshot.sessionId, snapshot)
    }
  } catch {
    // 已登记 session 仍会逐一 loadLatest；无法枚举的陌生记录不能安全地注册进 root。
  }
  return { snapshots, rejected }
}

function staticSessionMeta(snapshot: RecoverySnapshotV1): SessionMeta {
  // RecoverySessionMetaV1 的类型本身已排除 plan/executionGraph；显式挑选确保未来扩字段也不倒灌动态真源。
  const session = snapshot.session
  return {
    id: session.id,
    title: session.title,
    settings: session.settings,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.workspaceId === undefined ? {} : { workspaceId: session.workspaceId }),
    ...(session.workspaceRoot === undefined ? {} : { workspaceRoot: session.workspaceRoot }),
    ...(session.toolApprovalMode === undefined ? {} : { toolApprovalMode: session.toolApprovalMode }),
    ...(session.loadedTools === undefined ? {} : { loadedTools: session.loadedTools }),
  }
}

function withoutLegacyDynamicSessionMeta(session: SessionMeta): SessionMeta {
  const { plan: _legacyPlan, executionGraph: _legacyGraph, ...staticSession } = session
  return staticSession
}

/** 将会被终止进程遗留的运行态归类为可显式继续的 interrupted。 */
export function normalizeRecoverySnapshotForHydration(
  snapshot: RecoverySnapshotV1,
): RecoverySnapshotV1 {
  const run = snapshot.values.run
  if (!run || (run.status !== 'running' && run.status !== 'awaiting_tool' && run.status !== 'interrupted')) {
    return snapshot
  }
  return {
    ...snapshot,
    values: {
      ...snapshot.values,
      // 不加入 pendingExecutionId：它是进程生命周期内的 handle，重启后绝不可消费。
      run: { ...run, status: 'interrupted' },
    },
  }
}

/**
 * 读取每个 legacy session 的恢复代，并从 listLatest 补回 root 登记表丢失的 session。
 * 只要某 session 的 v1 记录无法读取或解码，它就被标记为 blocked，调用方不得触碰 legacy 动态字段。
 */
export async function prepareRecoveryHydration(
  recovery: RecoveryDriver | undefined,
  persistedSessions: SessionMeta[],
): Promise<RecoveryHydrationPlan> {
  if (!recovery) {
    return {
      sessionMetas: persistedSessions,
      snapshotsBySessionId: new Map(),
      blockedSessionIds: new Set(),
    }
  }

  const [listed, reads] = await Promise.all([
    listRecovery(recovery),
    Promise.all(persistedSessions.map(async (session) => [session.id, await readRecovery(recovery, session.id)] as const)),
  ])
  const snapshots = new Map<string, RecoverySnapshotV1>()
  const blocked = new Set(listed.rejected)

  for (const [sessionId, result] of reads) {
    if (result.state === 'blocked') {
      blocked.add(sessionId)
      continue
    }
    if (result.state === 'ready') snapshots.set(sessionId, result.snapshot)
  }
  for (const [sessionId, snapshot] of listed.snapshots) {
    if (!blocked.has(sessionId) && !snapshots.has(sessionId)) snapshots.set(sessionId, snapshot)
  }
  for (const sessionId of blocked) snapshots.delete(sessionId)

  const known = new Set(persistedSessions.map((session) => session.id))
  const sessionMetas = persistedSessions.map((session) => {
    const snapshot = snapshots.get(session.id)
    if (snapshot) return staticSessionMeta(snapshot)
    return blocked.has(session.id) ? withoutLegacyDynamicSessionMeta(session) : session
  })
  for (const [sessionId, snapshot] of snapshots) {
    if (!known.has(sessionId)) sessionMetas.push(staticSessionMeta(snapshot))
  }

  return {
    sessionMetas,
    snapshotsBySessionId: snapshots,
    blockedSessionIds: blocked,
  }
}
