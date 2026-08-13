import { DEFAULT_MODEL_SETTINGS, userMessageLabel, type UserMessageContent } from '@web-agent/ai'
import { activeSessionIdAtom, activeWorkspaceIdAtom, expandedWorkspaceIdsAtom, sessionsAtom, workspacesAtom } from '../../state/rootStore'
import type { ModelSettings, SessionMeta } from '../../state/core.type'
import type { CoreInstance } from '../core/coreInstance'
import { newId } from '../newId'
import { persistDeleteSession, persistSessions, persistWorkspaces } from '../persistenceBridge'
import { createWorkspaceMeta } from './workspaceCommands'
import { cancelSessionSubmissions } from '../sessionSubmissionGate'
import {
  captureUserContentReachability,
  disposeUserContentAfterMutation,
} from '../userContentDisposal'

export const DEFAULT_SESSION_TITLE = '新对话'

export function deriveSessionTitle(input: UserMessageContent): string {
  const compact = userMessageLabel(input).replace(/\s+/g, ' ').trim()
  if (!compact) return ''
  const chars = Array.from(compact)
  if (chars.length <= 12) return compact
  return `${chars.slice(0, 12).join('')}…`
}

/** Builds session CRUD commands bound to one runtime core. */
export function createSessionCommands(core: CoreInstance) {
  function renameSession(id: string, title: string): void {
    const trimmed = title.trim()
    if (!trimmed) return
    const next = Array.from(trimmed).slice(0, 48).join('')
    let changed = false
    core.rootStore.setter(sessionsAtom, (prev) => {
      const meta = prev[id]
      if (!meta) return prev
      changed = true
      return { ...prev, [id]: { ...meta, title: next, updatedAt: Date.now() } }
    })
    if (changed) persistSessions()
  }

  function newSession(opts?: {
    title?: string
    settings?: ModelSettings
    workspaceId?: string
  }): string {
    let workspaceId = opts?.workspaceId
    const workspaces = core.rootStore.getter(workspacesAtom)
    if (!workspaceId || !workspaces[workspaceId]) {
      const activeWorkspaceId = core.rootStore.getter(activeWorkspaceIdAtom)
      workspaceId = workspaces[activeWorkspaceId] ? activeWorkspaceId : undefined
    }
    if (!workspaceId) {
      const workspace = createWorkspaceMeta()
      workspaceId = workspace.id
      core.rootStore.setter(workspacesAtom, (prev) => ({ ...prev, [workspace.id]: workspace }))
    }
    const id = newId()
    // 缺省 provider 不是 core 能知道的事：优先用装配层配的默认设置，没有才退回
    // agent-ai 内置装配给出的缺省（与 provider registry 的 fallback 同源）。
    const settings: ModelSettings = opts?.settings
      ?? core.config.defaultModelSettings
      ?? { ...DEFAULT_MODEL_SETTINGS }
    const now = Date.now()
    const meta: SessionMeta = {
      id,
      title: opts?.title ?? DEFAULT_SESSION_TITLE,
      settings,
      createdAt: now,
      updatedAt: now,
      workspaceId,
    }
    core.rootStore.setter(sessionsAtom, (prev) => ({ ...prev, [id]: meta }))
    core.rootStore.setter(workspacesAtom, (prev) => {
      const workspace = prev[workspaceId]
      if (!workspace) return prev
      return { ...prev, [workspaceId]: { ...workspace, updatedAt: now } }
    })
    core.createSessionStore(id)
    core.rootStore.setter(activeWorkspaceIdAtom, workspaceId)
    core.rootStore.setter(expandedWorkspaceIdsAtom, (prev) => ({ ...prev, [workspaceId]: true }))
    core.rootStore.setter(activeSessionIdAtom, id)
    persistWorkspaces()
    persistSessions()
    return id
  }

  function selectSession(id: string): void {
    const session = core.rootStore.getter(sessionsAtom)[id]
    if (session?.workspaceId && core.rootStore.getter(workspacesAtom)[session.workspaceId]) {
      core.rootStore.setter(activeWorkspaceIdAtom, session.workspaceId)
      core.rootStore.setter(expandedWorkspaceIdsAtom, (prev) => ({
        ...prev,
        [session.workspaceId!]: true,
      }))
    }
    core.rootStore.setter(activeSessionIdAtom, id)
  }

  function removeSession(id: string): void {
    const meta = core.rootStore.getter(sessionsAtom)[id]
    const before = meta ? captureUserContentReachability(core, id) : undefined
    cancelSessionSubmissions(core, id)
    core.abort.abortRun(id)
    core.rootStore.setter(sessionsAtom, (prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    core.dropSessionStore(id)
    if (core.rootStore.getter(activeSessionIdAtom) === id) {
      const activeWorkspaceId = core.rootStore.getter(activeWorkspaceIdAtom)
      const remaining = Object.values(core.rootStore.getter(sessionsAtom))
        .filter((session) => session.workspaceId === activeWorkspaceId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
      core.rootStore.setter(activeSessionIdAtom, remaining[0]?.id ?? '')
    }
    persistSessions()
    persistDeleteSession(id)
    if (meta && before) {
      disposeUserContentAfterMutation(core, before, {
        sessionId: id,
        reason: 'session_removed',
        settings: { ...meta.settings },
      })
    }
  }

  function setApprovalMode(mode: 'confirm' | 'auto'): void {
    const id = core.rootStore.getter(activeSessionIdAtom)
    if (!id) return
    let changed = false
    core.rootStore.setter(sessionsAtom, (prev) => {
      const meta = prev[id]
      if (!meta || (meta.toolApprovalMode ?? 'confirm') === mode) return prev
      changed = true
      return { ...prev, [id]: { ...meta, toolApprovalMode: mode, updatedAt: Date.now() } }
    })
    if (changed) persistSessions()
  }

  return {
    renameSession,
    newSession,
    selectSession,
    removeSession,
    setApprovalMode,
  }
}
