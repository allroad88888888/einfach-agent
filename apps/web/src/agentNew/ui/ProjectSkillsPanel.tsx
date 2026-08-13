// 项目 Skills 设置面板：显示扫描结果并管理当前工作区的启停偏好。
// ---------------------------------------------------------------------------
// 快照按 workspaceRoot 缓存，用户偏好按稳定 workspaceId 保存；二者刻意分离，避免移动项目
// 目录后丢失选择，也避免把本机设置写进项目内的 SKILL.md。

import { useAtomValue } from '@einfach/react'
import {
  activeSessionMetaAtom,
  disabledProjectSkillsByWorkspaceAtom,
  projectSkillsAtom,
  workspacesAtom,
} from '@web-agent/core/state/rootStore'
import type { ProjectSkillEntry, ProjectSkillsSnapshot } from '@web-agent/core/skills/projectSkills'
import { resolveSessionWorkspaceRoot } from '@web-agent/core/state/workspaceState'
import {
  refreshProjectSkillsFromSettings,
  updateProjectSkillEnabled,
} from '../../settings/projectSkillsCommands'
import {
  projectSkillsPreferenceStatusAtom,
  projectSkillsRefreshingAtom,
} from '../../settings/projectSkillsState'
import './ProjectSkillsPanel.css'

type ProjectSkillsState = {
  workspaceId?: string
  workspaceRoot?: string
  snapshot?: ProjectSkillsSnapshot
}

function useProjectSkillsState(): ProjectSkillsState {
  const activeSession = useAtomValue(activeSessionMetaAtom)
  const workspaces = useAtomValue(workspacesAtom)
  const projectSkills = useAtomValue(projectSkillsAtom)
  if (!activeSession) return {}

  const workspaceRoot = resolveSessionWorkspaceRoot(activeSession, workspaces)
  if (!workspaceRoot) return {}
  return {
    workspaceId: activeSession.workspaceId,
    workspaceRoot,
    snapshot: projectSkills[workspaceRoot],
  }
}

function SkillEntry({
  entry,
  enabled,
  workspaceId,
}: {
  entry: ProjectSkillEntry
  enabled: boolean
  workspaceId: string
}) {
  const resourceCount = Object.keys(entry.resources).length
  const originLabel = entry.origin === 'agent' ? '.webAgent' : '.claude'
  const action = enabled ? '停用' : '启用'

  return (
    <article className={`project-skill-card${enabled ? '' : ' is-disabled'}`}>
      <div className="project-skill-card-head">
        <div>
          <div className="project-skill-card-title">
            <strong><code>{entry.name}</code></strong>
            <span className={`project-skill-status${enabled ? ' is-enabled' : ' is-disabled'}`}>
              <i aria-hidden="true" />{enabled ? '已启用' : '已停用'}
            </span>
          </div>
          <span className="project-skill-origin" title={`来源目录：${originLabel}/skills/`}>
            {originLabel}/skills/
          </span>
        </div>
        <button
          type="button"
          className="agentnew-settings-button is-small"
          aria-label={`${action} ${entry.name}`}
          aria-pressed={enabled}
          onClick={() => updateProjectSkillEnabled(workspaceId, entry.name, !enabled)}
        >
          {action}
        </button>
      </div>

      <p className="project-skill-description">{entry.description}</p>
      {resourceCount > 0 ? (
        <p className="project-skill-resources">附带 {resourceCount} 个资源文件</p>
      ) : null}
    </article>
  )
}

/** Manages discovered project skills for the workspace bound to the active conversation. */
export function ProjectSkillsPanel() {
  const { workspaceId, workspaceRoot, snapshot } = useProjectSkillsState()
  const disabledProjectSkills = useAtomValue(disabledProjectSkillsByWorkspaceAtom)
  const refreshing = useAtomValue(projectSkillsRefreshingAtom)
  const preferenceStatus = useAtomValue(projectSkillsPreferenceStatusAtom)

  if (!workspaceRoot || !workspaceId) {
    return (
      <section className="agentnew-settings-panel project-skills-panel">
        <div className="project-skills-empty">
          未绑定 workspace。绑定后，在桌面端可加载项目中的{' '}
          <code>.webAgent/skills/</code> 与 <code>.claude/skills/</code>。
        </div>
      </section>
    )
  }

  const entries = snapshot?.entries ?? []
  const diagnostics = snapshot?.diagnostics ?? []
  const disabledNames = new Set(disabledProjectSkills[workspaceId] ?? [])
  const enabledCount = entries.filter((entry) => !disabledNames.has(entry.name)).length

  return (
    <section className="agentnew-settings-panel project-skills-panel" aria-labelledby="project-skills-title">
      <div className="agentnew-settings-panel-head project-skills-head">
        <div>
          <h3 id="project-skills-title">项目 Skills</h3>
          <p>控制当前工作区中哪些项目技能可供 Agent 使用。</p>
        </div>
        <button
          type="button"
          className="agentnew-settings-button is-small"
          disabled={refreshing}
          onClick={() => { void refreshProjectSkillsFromSettings() }}
        >
          {refreshing ? '扫描中…' : '刷新'}
        </button>
      </div>

      <p className="project-skills-workspace" title={workspaceRoot}>
        当前工作区：<code>{workspaceRoot}</code>
      </p>
      <p className="project-skills-help">
        所有发现的技能默认启用。停用后，后续读取会立即受限；新对话不会再列出该技能。
        此选择仅保存在当前设备。
      </p>

      {snapshot && entries.length > 0 ? (
        <p className="project-skills-summary" role="status">
          已发现 {entries.length} 个技能，{enabledCount} 个已启用
        </p>
      ) : null}

      {preferenceStatus.status === 'saved' ? (
        <p className="project-skills-notice is-success" role="status">设置已保存</p>
      ) : null}
      {preferenceStatus.status === 'error' ? (
        <p className="project-skills-notice is-error" role="alert">{preferenceStatus.error}</p>
      ) : null}

      {diagnostics.length > 0 ? (
        <details className="project-skills-diagnostics">
          <summary>扫描反馈（{diagnostics.length} 条）</summary>
          <ul>
            {diagnostics.map((diagnostic, index) => <li key={index}>{diagnostic}</li>)}
          </ul>
        </details>
      ) : null}

      {!snapshot ? (
        <div className="project-skills-empty">
          尚未扫描。发送一条消息或点「刷新」后，会加载{' '}
          <code>.webAgent/skills/</code> 与 <code>.claude/skills/</code> 下的 Skills。
        </div>
      ) : entries.length === 0 ? (
        <div className="project-skills-empty">
          当前 workspace 未发现项目 Skills。在{' '}
          <code>.webAgent/skills/&lt;name&gt;/SKILL.md</code> 或{' '}
          <code>.claude/skills/&lt;name&gt;/SKILL.md</code> 中放置带 frontmatter 的 skill 文件即可自动加载。
        </div>
      ) : (
        <div className="project-skills-list">
          {entries.map((entry) => (
            <SkillEntry
              key={entry.name}
              entry={entry}
              enabled={!disabledNames.has(entry.name)}
              workspaceId={workspaceId}
            />
          ))}
        </div>
      )}
    </section>
  )
}
