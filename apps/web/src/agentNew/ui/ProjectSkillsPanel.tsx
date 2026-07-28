// apps/web/src/agentNew/ui/ProjectSkillsPanel.tsx
// ---------------------------------------------------------------------------
// 展示当前 workspace 的项目 Skills（来自 .agent/skills/ 与 .claude/skills/）。
// 在 web 环境下永远为空（非 Tauri 无 workspace 文件系统访问），
// Tauri 环境下显示 scanner 产出的快照条目与 diagnostics。
import { useState, useCallback } from 'react'
import { workspacesAtom, activeSessionMetaAtom, projectSkillsAtom } from '@web-agent/core/state/rootStore'
import { resolveSessionWorkspaceRoot } from '@web-agent/core/state/workspaceState'
import { refreshProjectSkills } from '@web-agent/core/runtime/commands'
import { useAtomValue } from '@einfach/react'
import type { ProjectSkillEntry, ProjectSkillsSnapshot } from '@web-agent/core/skills/projectSkills'

// U1：只读 atom + 调命令。快照存在 rootStore 的 projectSkillsAtom 里（不是 core 私有 Map），
// 所以重扫完成后这里会自动重渲染。
//
// 「未绑定 workspace」与「已绑定但尚未扫描」是两种不同状态，必须分开：后者在会话发出第一条
// 消息前（还没触发过 ensure）就是常态，报成「未绑定」会让用户去改一个本来就没问题的设置。
function useProjectSkillsState(): { workspaceRoot?: string; snapshot?: ProjectSkillsSnapshot } {
  const activeSession = useAtomValue(activeSessionMetaAtom)
  const workspaces = useAtomValue(workspacesAtom)
  const projectSkills = useAtomValue(projectSkillsAtom)
  if (!activeSession) return {}
  const workspaceRoot = resolveSessionWorkspaceRoot(activeSession, workspaces)
  if (!workspaceRoot) return {}
  return { workspaceRoot, snapshot: projectSkills[workspaceRoot] }
}

function SkillEntry({ entry }: { entry: ProjectSkillEntry }) {
  const resourceCount = Object.keys(entry.resources).length
  const originLabel = entry.origin === 'agent' ? '.agent' : '.claude'
  return (
    <div className="project-skill-entry">
      <span className="project-skill-name">
        <code>{entry.name}</code>
      </span>
      <span className="project-skill-origin" title={`来源目录：${originLabel}/skills/`}>
        {originLabel}
      </span>
      <span className="project-skill-desc">{entry.description}</span>
      {resourceCount > 0 && (
        <span className="project-skill-resources">{resourceCount} 个资源文件</span>
      )}
    </div>
  )
}

export function ProjectSkillsPanel() {
  const { workspaceRoot, snapshot } = useProjectSkillsState()
  const [refreshing, setRefreshing] = useState(false)

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await refreshProjectSkills()
    } finally {
      setRefreshing(false)
    }
  }, [])

  if (!workspaceRoot) {
    return (
      <div className="project-skills-panel">
        <div className="project-skills-empty">
          未绑定 workspace。绑定后在 Tauri 桌面端可自动加载项目内{' '}
          <code>.agent/skills/</code> 与 <code>.claude/skills/</code> 提供的 Skills。
        </div>
      </div>
    )
  }

  const entries = snapshot?.entries ?? []
  const diagnostics = snapshot?.diagnostics ?? []

  return (
    <div className="project-skills-panel">
      <div className="project-skills-header">
        <h3>项目 Skills</h3>
        <span className="project-skills-workspace" title={workspaceRoot}>
          {workspaceRoot}
        </span>
        <button
          className="project-skills-refresh"
          onClick={handleRefresh}
          disabled={refreshing}
          title="重新扫描项目 Skills"
        >
          {refreshing ? '扫描中…' : '刷新'}
        </button>
      </div>

      {diagnostics.length > 0 && (
        <div className="project-skills-diagnostics">
          <details>
            <summary>⚠ 扫描反馈（{diagnostics.length} 条）</summary>
            <ul>
              {diagnostics.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          </details>
        </div>
      )}

      {!snapshot ? (
        <div className="project-skills-empty">
          尚未扫描。发送一条消息或点「刷新」后，会自动加载{' '}
          <code>.agent/skills/</code> 与 <code>.claude/skills/</code> 下的 Skills。
        </div>
      ) : entries.length === 0 ? (
        <div className="project-skills-empty">
          当前 workspace 未发现项目 Skills。在{' '}
          <code>.agent/skills/&lt;name&gt;/SKILL.md</code> 或{' '}
          <code>.claude/skills/&lt;name&gt;/SKILL.md</code>{' '}
          中放置带 frontmatter 的 skill 文件即可自动加载。
        </div>
      ) : (
        <div className="project-skills-list">
          {entries.map((entry) => (
            <SkillEntry key={entry.name} entry={entry} />
          ))}
        </div>
      )}
    </div>
  )
}
