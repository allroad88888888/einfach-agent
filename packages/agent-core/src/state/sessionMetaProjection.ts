// SessionMeta 的静态持久化投影。动态运行态只能由 recovery v1 表示。

import type { SessionMeta } from './core.type'

/**
 * Selects the static session registration fields instead of spreading a raw
 * persisted object. This prevents obsolete dynamic mirrors from being written
 * back when old storage is read and later saved.
 */
export function projectStaticSessionMeta(session: SessionMeta): SessionMeta {
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
