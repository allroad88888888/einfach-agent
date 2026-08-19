import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activeSessionIdAtom,
  disabledProjectSkillsByWorkspaceAtom,
  projectSkillsAtom,
  rootStore,
  sessionsAtom,
  workspacesAtom,
  type SessionMeta,
} from '@einfach-agent/core'
import type { ProjectSkillsSnapshot } from '@einfach-agent/core/skills'
import { renderWithStore } from '../../test/renderWithStore'
import { ProjectSkillsPanel } from './ProjectSkillsPanel'
import {
  refreshProjectSkillsFromSettings,
  updateProjectSkillEnabled,
} from '../../settings/projectSkillsCommands'

vi.mock('../../settings/projectSkillsCommands', () => ({
  refreshProjectSkillsFromSettings: vi.fn(),
  updateProjectSkillEnabled: vi.fn(),
}))

const workspaceRoot = '/workspace/project'

function seedPanel(snapshot?: ProjectSkillsSnapshot): void {
  const session: SessionMeta = {
    id: 'project-skills-panel',
    title: '项目 Skills',
    settings: { vendor: 'deepseek', model: 'deepseek-chat' },
    createdAt: 0,
    updatedAt: 0,
    workspaceId: 'workspace-1',
  }
  rootStore.setter(workspacesAtom, {
    'workspace-1': {
      id: 'workspace-1',
      name: 'Project',
      rootPath: workspaceRoot,
      createdAt: 0,
      updatedAt: 0,
    },
  })
  rootStore.setter(sessionsAtom, { [session.id]: session })
  rootStore.setter(activeSessionIdAtom, session.id)
  rootStore.setter(projectSkillsAtom, snapshot ? { [workspaceRoot]: snapshot } : {})
}

function projectSkillSnapshot(entries: ProjectSkillsSnapshot['entries']): ProjectSkillsSnapshot {
  return { workspaceRoot, entries, diagnostics: [] }
}

describe('ProjectSkillsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    rootStore.setter(workspacesAtom, {})
    rootStore.setter(sessionsAtom, {})
    rootStore.setter(activeSessionIdAtom, '')
    rootStore.setter(projectSkillsAtom, {})
    rootStore.setter(disabledProjectSkillsByWorkspaceAtom, {})
  })

  afterEach(() => {
    rootStore.setter(projectSkillsAtom, {})
    rootStore.setter(disabledProjectSkillsByWorkspaceAtom, {})
  })

  it('在所有项目 Skills 空状态中显示 .webAgent/skills，且不显示旧路径', () => {
    const unbound = renderWithStore(<ProjectSkillsPanel />)
    expect(unbound.container).toHaveTextContent('.webAgent/skills/')
    unbound.unmount()

    seedPanel()
    const unscanned = renderWithStore(<ProjectSkillsPanel />)
    expect(unscanned.container).toHaveTextContent('.webAgent/skills/')
    unscanned.unmount()

    seedPanel(projectSkillSnapshot([]))
    const empty = renderWithStore(<ProjectSkillsPanel />)
    expect(empty.container).toHaveTextContent('.webAgent/skills/<name>/SKILL.md')
  })

  it('管理当前 workspace 的启停状态，并保留刷新行为', async () => {
    seedPanel(projectSkillSnapshot([{
      name: 'project/release-check',
      description: '发布检查',
      triggers: [],
      filePath: '.webAgent/skills/release-check/SKILL.md',
      resources: {},
      origin: 'agent',
      scope: 'project',
      rootPath: '/workspace',
    }]))
    rootStore.setter(disabledProjectSkillsByWorkspaceAtom, {
      'workspace-1': ['project/release-check'],
    })
    const user = userEvent.setup()
    renderWithStore(<ProjectSkillsPanel />)

    expect(screen.getByText('.webAgent/skills/')).toHaveAttribute('title', '来源目录：.webAgent/skills/')
    expect(screen.getByText('已停用')).toBeInTheDocument()
    expect(screen.getByText('已发现 1 个技能，0 个已启用')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '启用 project/release-check' }))
    expect(updateProjectSkillEnabled).toHaveBeenCalledWith(
      'workspace-1',
      'project/release-check',
      true,
    )
    await user.click(screen.getByRole('button', { name: '刷新' }))
    expect(refreshProjectSkillsFromSettings).toHaveBeenCalledOnce()
  })

  it('工作区与用户目录分两组，来源标注带 ~/ 以区分同名目录', () => {
    seedPanel({
      workspaceRoot,
      userSkillsRoot: '/Users/me',
      diagnostics: [],
      entries: [
        {
          name: 'project/release-check',
          description: '发布检查',
          triggers: [],
          filePath: '.claude/skills/release-check/SKILL.md',
          resources: {},
          origin: 'claude',
          scope: 'project',
          rootPath: '/workspace',
        },
        {
          name: 'user/notes',
          description: '主目录笔记',
          triggers: [],
          filePath: '.claude/skills/notes/SKILL.md',
          resources: {},
          origin: 'claude',
          scope: 'user',
          rootPath: '/Users/me',
        },
      ],
    })
    renderWithStore(<ProjectSkillsPanel />)

    expect(screen.getByText('工作区')).toBeInTheDocument()
    expect(screen.getByText('用户目录')).toBeInTheDocument()
    expect(screen.getByText('/Users/me')).toBeInTheDocument()
    // 两条都来自 .claude/skills，只有 `~/` 能把它们区分开
    expect(screen.getByText('.claude/skills/')).toBeInTheDocument()
    expect(screen.getByText('~/.claude/skills/')).toBeInTheDocument()
  })
})
