import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { useAtom } from '@einfach/react'
import { useRootAtomValue } from '@einfach-agent/react-plugin'
import { Trans, useLingui } from '@lingui/react/macro'
import {
  activeWorkspaceIdAtom,
  expandedWorkspaceIdsAtom,
  workspaceSettingsOpenIdsAtom,
  workspacesAtom,
  newSession,
  newWorkspace,
  removeWorkspace,
  renameWorkspace,
  selectWorkspace,
  toggleWorkspaceExpanded,
  toggleWorkspaceSettings,
} from '@einfach-agent/core'
import { workspaceRenameStateAtom } from './workspaceViewState'
import { SessionList } from './SessionList'
import { WorkspaceRootField } from './WorkspaceRootField'

export function WorkspaceSidebar() {
  const { t } = useLingui()
  const workspaces = useRootAtomValue(workspacesAtom)
  const activeWorkspaceId = useRootAtomValue(activeWorkspaceIdAtom)
  const expandedWorkspaceIds = useRootAtomValue(expandedWorkspaceIdsAtom)
  const workspaceSettingsOpenIds = useRootAtomValue(workspaceSettingsOpenIdsAtom)
  const [renameState, setRenameState] = useAtom(workspaceRenameStateAtom)
  const renameSettledRef = useRef(false)
  const ordered = Object.values(workspaces).sort(
    (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id),
  )
  const settingsWorkspace = activeWorkspaceId
    ? ordered.find(
        (workspace) =>
          workspace.id === activeWorkspaceId
          && (workspaceSettingsOpenIds[workspace.id] ?? false),
      )
    : undefined

  // 新工作区先以空根创建；用户在设置弹层里手动填写，或在有本机宿主桥时选择系统文件夹。
  function startRename(id: string, name: string): void {
    renameSettledRef.current = false
    setRenameState({ id, draft: name })
  }

  function commitRename(id: string): void {
    if (renameSettledRef.current || renameState?.id !== id) return
    renameSettledRef.current = true
    setRenameState(null)
    renameWorkspace(id, renameState.draft)
  }

  function cancelRename(): void {
    renameSettledRef.current = true
    setRenameState(null)
  }

  return (
    <>
      <div className="agentnew-workspaces">
        <div className="agentnew-workspaces-heading">
          <span><Trans>工作区</Trans></span>
          <button
            type="button"
            className="agentnew-new-workspace"
            aria-label={t`新建工作区`}
            title={t`新建工作区`}
            onClick={() => {
              newWorkspace()
            }}
          >
            +
          </button>
        </div>

        {ordered.length === 0
          ? <div className="agentnew-workspaces-empty"><Trans>新建工作区后即可创建对话</Trans></div>
          : ordered.map((workspace) => {
              const isActive = workspace.id === activeWorkspaceId
              const isExpanded = expandedWorkspaceIds[workspace.id] ?? false
              const isSettingsOpen = workspaceSettingsOpenIds[workspace.id] ?? false
              const isRenaming = renameState?.id === workspace.id
              return (
                <section
                  key={workspace.id}
                  className={`agentnew-workspace${isActive ? ' active' : ''}`}
                >
                  <div className="agentnew-workspace-heading">
                    <button
                      type="button"
                      className="agentnew-workspace-toggle"
                      aria-label={isExpanded
                        ? t`折叠 ${workspace.name}`
                        : t`展开 ${workspace.name}`}
                      aria-expanded={isExpanded}
                      onClick={() => toggleWorkspaceExpanded(workspace.id)}
                    >
                      {isExpanded ? '⌄' : '›'}
                    </button>
                    {isRenaming ? (
                      <input
                        className="agentnew-workspace-rename-input"
                        value={renameState.draft}
                        autoFocus
                        aria-label={t`重命名工作区`}
                        onFocus={(event) => event.target.select()}
                        onChange={(event) => {
                          setRenameState({ id: workspace.id, draft: event.target.value })
                        }}
                        onKeyDown={(event) => {
                          if (event.nativeEvent.isComposing) return
                          if (event.key === 'Enter') commitRename(workspace.id)
                          else if (event.key === 'Escape') cancelRename()
                        }}
                        onBlur={() => commitRename(workspace.id)}
                      />
                    ) : (
                      <button
                        type="button"
                        className="agentnew-workspace-name"
                        title={workspace.rootPath ?? workspace.name}
                        onClick={() => selectWorkspace(workspace.id)}
                        onDoubleClick={() => startRename(workspace.id, workspace.name)}
                      >
                        {workspace.name}
                      </button>
                    )}
                    <button
                      type="button"
                      className="agentnew-workspace-new-session"
                      aria-label={t`在 ${workspace.name} 中新建对话`}
                      title={t`新建对话`}
                      onClick={() => newSession({ workspaceId: workspace.id })}
                    >
                      +
                    </button>
                    <button
                      type="button"
                      className={`agentnew-workspace-settings${isSettingsOpen ? ' active' : ''}`}
                      aria-label={t`设置 ${workspace.name}`}
                      aria-haspopup="dialog"
                      aria-expanded={isSettingsOpen}
                      title={t`工作区设置`}
                      onClick={() => toggleWorkspaceSettings(workspace.id)}
                    >
                      ⚙
                    </button>
                    <button
                      type="button"
                      className="agentnew-workspace-remove"
                      aria-label={t`删除 ${workspace.name}`}
                      title={t`删除工作区（不会删除磁盘文件）`}
                      onClick={() => removeWorkspace(workspace.id)}
                    >
                      ×
                    </button>
                  </div>
                  {isExpanded ? (
                    <div className="agentnew-workspace-content">
                      <SessionList workspaceId={workspace.id} />
                    </div>
                  ) : null}
                </section>
              )
            })}
      </div>

      {settingsWorkspace
        ? createPortal(
            <div
              className="agentnew-workspace-settings-backdrop"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                  toggleWorkspaceSettings(settingsWorkspace.id)
                }
              }}
            >
              <section
                className="agentnew-workspace-settings-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="agentnew-workspace-settings-title"
              >
                <header className="agentnew-workspace-settings-header">
                  <div>
                    <div className="agentnew-workspace-settings-eyebrow"><Trans>工作区设置</Trans></div>
                    <h2 id="agentnew-workspace-settings-title">{settingsWorkspace.name}</h2>
                  </div>
                  <button
                    type="button"
                    className="agentnew-workspace-settings-close"
                    aria-label={t`关闭工作区设置`}
                    title={t`关闭`}
                    onClick={() => toggleWorkspaceSettings(settingsWorkspace.id)}
                  >
                    ×
                  </button>
                </header>
                <div className="agentnew-workspace-settings-body">
                  <section className="agentnew-workspace-settings-section">
                    <h3><Trans>常规</Trans></h3>
                    <p><Trans>配置这个工作区使用的目录。后续工作区级功能也会集中放在这里。</Trans></p>
                    <WorkspaceRootField />
                  </section>
                </div>
              </section>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
