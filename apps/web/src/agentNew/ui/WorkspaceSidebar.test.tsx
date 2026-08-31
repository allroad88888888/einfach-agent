import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { I18nProvider } from '@lingui/react'
import { renderWithStore } from '../../test/renderWithStore'
import { activateLocale, appI18n } from '../../i18n'
import {
  activeSessionIdAtom,
  activeWorkspaceIdAtom,
  expandedWorkspaceIdsAtom,
  workspaceSettingsOpenIdsAtom,
  rootStore,
  sessionsAtom,
  workspacesAtom,
  newSession,
  newWorkspace,
  removeWorkspace,
  renameWorkspace,
  selectWorkspace,
  toggleWorkspaceExpanded,
  toggleWorkspaceSettings,
} from '@einfach-agent/core'
import { WorkspaceSidebar } from './WorkspaceSidebar'

vi.mock('@einfach-agent/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@einfach-agent/core')>()),
  newWorkspace: vi.fn(),
  removeWorkspace: vi.fn(),
  renameWorkspace: vi.fn(),
  selectWorkspace: vi.fn(),
  toggleWorkspaceExpanded: vi.fn(),
  toggleWorkspaceSettings: vi.fn(),
  newSession: vi.fn(),
  selectSession: vi.fn(),
  removeSession: vi.fn(),
  renameSession: vi.fn(),
  setWorkspaceRoot: vi.fn(),
}))

function seed(): void {
  rootStore.setter(workspacesAtom, {
    w1: {
      id: 'w1',
      name: '项目一',
      rootPath: '/workspace/one',
      createdAt: 1,
      updatedAt: 2,
    },
    w2: {
      id: 'w2',
      name: '项目二',
      rootPath: '/workspace/two',
      createdAt: 2,
      updatedAt: 1,
    },
  })
  rootStore.setter(activeWorkspaceIdAtom, 'w1')
  rootStore.setter(expandedWorkspaceIdsAtom, { w1: true, w2: false })
  rootStore.setter(sessionsAtom, {
    s1: {
      id: 's1',
      title: '一号对话',
      settings: { vendor: 'deepseek', model: 'x' },
      createdAt: 1,
      updatedAt: 1,
      workspaceId: 'w1',
    },
    s2: {
      id: 's2',
      title: '二号对话',
      settings: { vendor: 'deepseek', model: 'x' },
      createdAt: 2,
      updatedAt: 2,
      workspaceId: 'w2',
    },
  })
  rootStore.setter(activeSessionIdAtom, 's1')
}

function renderSidebar() {
  return renderWithStore(
    <I18nProvider i18n={appI18n}>
      <WorkspaceSidebar />
    </I18nProvider>,
  )
}

describe('WorkspaceSidebar', () => {
  beforeEach(async () => {
    await activateLocale('zh-CN')
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('按“工作区 → 对话”渲染；折叠的工作区不展示其对话', () => {
    seed()
    renderSidebar()

    expect(screen.getByText('项目一')).toBeInTheDocument()
    expect(screen.getByText('项目二')).toBeInTheDocument()
    expect(screen.getByText('一号对话')).toBeInTheDocument()
    expect(screen.queryByText('二号对话')).toBeNull()
    expect(screen.getByRole('button', { name: '折叠 项目一' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: '展开 项目二' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('工作区标题右侧的新建按钮固定归属该工作区', () => {
    seed()
    renderSidebar()

    fireEvent.click(screen.getByRole('button', { name: '在 项目一 中新建对话' }))
    expect(newSession).toHaveBeenCalledWith({ workspaceId: 'w1' })
  })

  it('悬停操作区的删除按钮移除对应工作区，不删除磁盘文件', () => {
    seed()
    renderSidebar()

    const remove = screen.getByRole('button', { name: '删除 项目一' })
    expect(remove).toHaveAttribute('title', '删除工作区（不会删除磁盘文件）')
    expect(remove).toHaveTextContent('×')
    fireEvent.click(remove)
    expect(removeWorkspace).toHaveBeenCalledWith('w1')
  })

  it('可新建、切换和折叠展开工作区', () => {
    seed()
    renderSidebar()

    fireEvent.click(screen.getByRole('button', { name: '新建工作区' }))
    expect(newWorkspace).toHaveBeenCalledWith()

    fireEvent.click(screen.getByRole('button', { name: '项目二' }))
    expect(selectWorkspace).toHaveBeenCalledWith('w2')

    fireEvent.click(screen.getByRole('button', { name: '折叠 项目一' }))
    fireEvent.click(screen.getByRole('button', { name: '展开 项目二' }))
    expect(toggleWorkspaceExpanded).toHaveBeenNthCalledWith(1, 'w1')
    expect(toggleWorkspaceExpanded).toHaveBeenNthCalledWith(2, 'w2')
  })

  it('标题双击进入行内编辑，Enter 提交工作区名称', () => {
    seed()
    renderSidebar()

    fireEvent.doubleClick(screen.getByRole('button', { name: '项目一' }))
    const input = screen.getByRole('textbox', { name: '重命名工作区' })
    fireEvent.change(input, { target: { value: '新的项目名' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(renameWorkspace).toHaveBeenCalledWith('w1', '新的项目名')
    expect(screen.queryByRole('textbox', { name: '重命名工作区' })).toBeNull()
  })

  it('标题右侧设置按钮打开居中设置弹层，目录默认不常驻列表', () => {
    seed()
    const firstRender = renderSidebar()

    expect(screen.queryByLabelText('工作区目录')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '设置 项目一' }))
    expect(toggleWorkspaceSettings).toHaveBeenCalledWith('w1')
    firstRender.unmount()

    rootStore.setter(workspaceSettingsOpenIdsAtom, { w1: true })
    renderSidebar()
    expect(screen.getByRole('dialog', { name: '项目一' })).toBeInTheDocument()
    expect(screen.getByText(/后续工作区级功能也会集中放在这里/)).toBeInTheDocument()
    expect(screen.getByLabelText('工作区目录')).toHaveValue('/workspace/one')

    fireEvent.click(screen.getByRole('button', { name: '关闭工作区设置' }))
    expect(toggleWorkspaceSettings).toHaveBeenCalledWith('w1')
  })

  it('英语激活时翻译侧栏静态动作和设置内容，不改变工作区操作', async () => {
    seed()
    await activateLocale('en')
    const firstRender = renderSidebar()

    expect(screen.getByText('Workspaces')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Collapse 项目一' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Expand 项目二' })).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'New conversation in 项目一' }))
    expect(newSession).toHaveBeenCalledWith({ workspaceId: 'w1' })

    firstRender.unmount()
    rootStore.setter(workspaceSettingsOpenIdsAtom, { w1: true })
    renderSidebar()
    expect(screen.getByText('Workspace settings')).toBeInTheDocument()
    expect(screen.getByText('General')).toBeInTheDocument()
    expect(screen.getByText('Configure the directory used by this workspace. Future workspace-level features will also live here.')).toBeInTheDocument()
  })
})
