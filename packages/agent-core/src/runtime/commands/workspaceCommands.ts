import {
  activeSessionIdAtom,
  activeWorkspaceIdAtom,
  expandedWorkspaceIdsAtom,
  sessionsAtom,
  workspacesAtom,
  workspaceSettingsOpenIdsAtom,
} from '../../state/rootStore'
import type { WorkspaceMeta } from '../../state/core.type'
import {
  DEFAULT_WORKSPACE_NAME,
  deriveWorkspaceName,
  normalizeWorkspaceRoot,
} from '../../state/workspaceState'
import type { CoreInstance } from '../core/coreInstance'
import { newId } from '../newId'
import { persistWorkspaces } from '../persistenceBridge'

export interface WorkspaceOptions {
  name?: string
  rootPath?: string
}

export function createWorkspaceMeta(opts?: WorkspaceOptions): WorkspaceMeta {
  const id = newId()
  const now = Date.now()
  const rootPath = normalizeWorkspaceRoot(opts?.rootPath)
  return {
    id,
    name: opts?.name?.trim() || deriveWorkspaceName(rootPath) || DEFAULT_WORKSPACE_NAME,
    rootPath,
    createdAt: now,
    updatedAt: now,
  }
}

/** Builds workspace CRUD commands bound to one runtime core. */
export function createWorkspaceCommands(core: CoreInstance) {
  function activateWorkspace(id: string): void {
    const workspace = core.rootStore.getter(workspacesAtom)[id]
    if (!workspace) return
    core.rootStore.setter(activeWorkspaceIdAtom, id)
    core.rootStore.setter(expandedWorkspaceIdsAtom, (prev) => ({ ...prev, [id]: true }))
    const currentSessionId = core.rootStore.getter(activeSessionIdAtom)
    const sessions = core.rootStore.getter(sessionsAtom)
    if (sessions[currentSessionId]?.workspaceId === id) return
    const latest = Object.values(sessions)
      .filter((session) => session.workspaceId === id)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    core.rootStore.setter(activeSessionIdAtom, latest?.id ?? '')
  }

  function newWorkspace(opts?: WorkspaceOptions): string {
    const rootPath = normalizeWorkspaceRoot(opts?.rootPath)
    if (rootPath) {
      const existing = Object.values(core.rootStore.getter(workspacesAtom))
        .find((workspace) => normalizeWorkspaceRoot(workspace.rootPath) === rootPath)
      if (existing) {
        activateWorkspace(existing.id)
        return existing.id
      }
    }
    const workspace = createWorkspaceMeta({ ...opts, rootPath })
    core.rootStore.setter(workspacesAtom, (prev) => ({ ...prev, [workspace.id]: workspace }))
    core.rootStore.setter(activeWorkspaceIdAtom, workspace.id)
    core.rootStore.setter(expandedWorkspaceIdsAtom, (prev) => ({ ...prev, [workspace.id]: true }))
    core.rootStore.setter(activeSessionIdAtom, '')
    persistWorkspaces()
    return workspace.id
  }

  function selectWorkspace(id: string): void {
    activateWorkspace(id)
  }

  function toggleWorkspaceExpanded(id: string): void {
    if (!core.rootStore.getter(workspacesAtom)[id]) return
    core.rootStore.setter(expandedWorkspaceIdsAtom, (prev) => ({
      ...prev,
      [id]: !(prev[id] ?? false),
    }))
  }

  function toggleWorkspaceSettings(id: string): void {
    if (!core.rootStore.getter(workspacesAtom)[id]) return
    activateWorkspace(id)
    core.rootStore.setter(workspaceSettingsOpenIdsAtom, (prev) => (prev[id] ? {} : { [id]: true }))
  }

  function renameWorkspace(id: string, name: string): void {
    const trimmed = name.trim()
    if (!trimmed) return
    const chars = Array.from(trimmed)
    const nextName = chars.length > 48 ? `${chars.slice(0, 47).join('')}…` : trimmed
    let changed = false
    core.rootStore.setter(workspacesAtom, (prev) => {
      const workspace = prev[id]
      if (!workspace || workspace.name === nextName) return prev
      changed = true
      return {
        ...prev,
        [id]: { ...workspace, name: nextName, updatedAt: Date.now() },
      }
    })
    if (changed) persistWorkspaces()
  }

  function setWorkspaceRoot(root: string): void {
    const id = core.rootStore.getter(activeWorkspaceIdAtom)
    if (!id) return
    const rootPath = normalizeWorkspaceRoot(root)
    let changed = false
    core.rootStore.setter(workspacesAtom, (prev) => {
      const workspace = prev[id]
      if (!workspace || workspace.rootPath === rootPath) return prev
      changed = true
      return {
        ...prev,
        [id]: {
          ...workspace,
          name: workspace.name === DEFAULT_WORKSPACE_NAME && rootPath
            ? deriveWorkspaceName(rootPath)
            : workspace.name,
          rootPath,
          updatedAt: Date.now(),
        },
      }
    })
    if (changed) persistWorkspaces()
  }

  return {
    newWorkspace,
    selectWorkspace,
    toggleWorkspaceExpanded,
    toggleWorkspaceSettings,
    renameWorkspace,
    setWorkspaceRoot,
  }
}
