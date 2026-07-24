import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { renderWithStore } from '../../test/renderWithStore'
import {
  activeSessionIdAtom,
  activeWorkspaceIdAtom,
  expandedWorkspaceIdsAtom,
  workspaceSettingsOpenIdsAtom,
  resetRootStore,
  rootStore,
  sessionsAtom,
  workspacesAtom,
} from '@web-agent/core/state/rootStore'
import {
  newSession,
  newWorkspace,
  renameWorkspace,
  selectWorkspace,
  toggleWorkspaceExpanded,
  toggleWorkspaceSettings,
} from '@web-agent/core/runtime/commands'
import { WorkspaceSidebar } from './WorkspaceSidebar'

vi.mock('@web-agent/core/runtime/commands', () => ({
  newWorkspace: vi.fn(),
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

vi.mock('@web-agent/core/runtime/workspaceDialog', () => ({
  canPickWorkspaceDirectory: vi.fn(() => false),
  pickWorkspaceDirectory: vi.fn(),
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

describe('WorkspaceSidebar', () => {
  afterEach(() => {
    resetRootStore()
    vi.clearAllMocks()
  })

  it('按“工作区 → 对话”渲染；折叠的工作区不展示其对话', () => {
    seed()
    renderWithStore(<WorkspaceSidebar />, { store: rootStore })

    expect(screen.getByText('项目一')).toBeInTheDocument()
    expect(screen.getByText('项目二')).toBeInTheDocument()
    expect(screen.getByText('一号对话')).toBeInTheDocument()
    expect(screen.queryByText('二号对话')).toBeNull()
    expect(screen.getByRole('button', { name: '折叠 项目一' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: '展开 项目二' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('新建对话固定归属当前展开的工作区', () => {
    seed()
    renderWithStore(<WorkspaceSidebar />, { store: rootStore })

    fireEvent.click(screen.getByRole('button', { name: /新建对话/ }))
    expect(newSession).toHaveBeenCalledWith({ workspaceId: 'w1' })
  })

  it('可新建、切换和折叠展开工作区', () => {
    seed()
    renderWithStore(<WorkspaceSidebar />, { store: rootStore })

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
    renderWithStore(<WorkspaceSidebar />, { store: rootStore })

    fireEvent.doubleClick(screen.getByRole('button', { name: '项目一' }))
    const input = screen.getByRole('textbox', { name: '重命名工作区' })
    fireEvent.change(input, { target: { value: '新的项目名' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(renameWorkspace).toHaveBeenCalledWith('w1', '新的项目名')
    expect(screen.queryByRole('textbox', { name: '重命名工作区' })).toBeNull()
  })

  it('标题右侧设置按钮打开居中设置弹层，目录默认不常驻列表', () => {
    seed()
    const firstRender = renderWithStore(<WorkspaceSidebar />, { store: rootStore })

    expect(screen.queryByLabelText('工作区目录')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '设置 项目一' }))
    expect(toggleWorkspaceSettings).toHaveBeenCalledWith('w1')
    firstRender.unmount()

    rootStore.setter(workspaceSettingsOpenIdsAtom, { w1: true })
    renderWithStore(<WorkspaceSidebar />, { store: rootStore })
    expect(screen.getByRole('dialog', { name: '项目一' })).toBeInTheDocument()
    expect(screen.getByText(/后续工作区级功能也会集中放在这里/)).toBeInTheDocument()
    expect(screen.getByLabelText('工作区目录')).toHaveValue('/workspace/one')

    fireEvent.click(screen.getByRole('button', { name: '关闭工作区设置' }))
    expect(toggleWorkspaceSettings).toHaveBeenCalledWith('w1')
  })
})
