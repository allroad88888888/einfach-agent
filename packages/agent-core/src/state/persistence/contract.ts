import type { SessionMeta, WorkspaceMeta } from '../core.type'

// 会话列表持久化契约：浏览器与桌面实现都完整保存会话和工作区。
export interface SessionsPersistence {
  saveSessions(sessions: SessionMeta[], diagnosticOperationId?: string): Promise<void>
  loadSessions(): Promise<SessionMeta[]>
  saveWorkspaces(workspaces: WorkspaceMeta[]): Promise<void>
  loadWorkspaces(): Promise<WorkspaceMeta[]>
}
