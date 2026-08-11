import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activeSessionIdAtom,
  projectSkillsAtom,
  rootStore,
  sessionsAtom,
  workspacesAtom,
} from '@web-agent/core/state/rootStore'
import type { ProjectSkillsSnapshot } from '@web-agent/core/skills/projectSkills'
import type { SessionMeta } from '@web-agent/core/state/core.type'
import { renderWithStore } from '../../test/renderWithStore'
import { ProjectSkillsPanel } from './ProjectSkillsPanel'
import { refreshProjectSkills } from '@web-agent/core/runtime/commands'

vi.mock('@web-agent/core/runtime/commands', () => ({
  refreshProjectSkills: vi.fn(),
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
  })

  afterEach(() => {
    rootStore.setter(projectSkillsAtom, {})
  })

  it('在所有项目 Skills 空状态中显示 .webAgent/skills，且不显示旧路径', () => {
    const unbound = renderWithStore(<ProjectSkillsPanel />, { store: rootStore })
    expect(unbound.container).toHaveTextContent('.webAgent/skills/')
    unbound.unmount()

    seedPanel()
    const unscanned = renderWithStore(<ProjectSkillsPanel />, { store: rootStore })
    expect(unscanned.container).toHaveTextContent('.webAgent/skills/')
    unscanned.unmount()

    seedPanel(projectSkillSnapshot([]))
    const empty = renderWithStore(<ProjectSkillsPanel />, { store: rootStore })
    expect(empty.container).toHaveTextContent('.webAgent/skills/<name>/SKILL.md')
  })

  it('保留刷新行为，并将 agent 来源显示为 .webAgent/skills', async () => {
    seedPanel(projectSkillSnapshot([{
      name: 'project/release-check',
      description: '发布检查',
      triggers: [],
      filePath: '.webAgent/skills/release-check/SKILL.md',
      resources: {},
      origin: 'agent',
    }]))
    const user = userEvent.setup()
    renderWithStore(<ProjectSkillsPanel />, { store: rootStore })

    expect(screen.getByText('.webAgent')).toHaveAttribute('title', '来源目录：.webAgent/skills/')
    await user.click(screen.getByRole('button', { name: '刷新' }))
    expect(refreshProjectSkills).toHaveBeenCalledOnce()
  })
})
