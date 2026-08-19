import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithStore } from '../../test/renderWithStore'
import { activeWorkspaceIdAtom, rootStore, workspacesAtom, setWorkspaceRoot } from '@einfach-agent/core'
import { WorkspaceRootField } from './WorkspaceRootField'

// 【T1】此前这里还有一条「点『选择』按钮 → 原生目录选择框 → 写回 rootPath」的用例。那枚按钮随桌面端
// 一起删了（唯一实现是桌面 dialog 插件，删掉之后它恒 disabled），所以只剩手工输入这一条真实路径。
vi.mock('@einfach-agent/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@einfach-agent/core')>()),
  setWorkspaceRoot: vi.fn(),
}))

function seedActiveSession(): void {
  rootStore.setter(workspacesAtom, {
    w1: {
      id: 'w1',
      name: 'workspace',
      rootPath: '/current/workspace',
      createdAt: 0,
      updatedAt: 0,
    },
  })
  rootStore.setter(activeWorkspaceIdAtom, 'w1')
}

describe('WorkspaceRootField', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('手工输入路径后写入当前一级工作区', async () => {
    seedActiveSession()
    renderWithStore(<WorkspaceRootField />)

    const input = screen.getByLabelText('工作区目录')
    expect(input).toHaveValue('/current/workspace')
    // 输入框没有「选择目录」的兄弟控件了：只剩这一条路。
    expect(screen.queryByRole('button', { name: '选择' })).toBeNull()

    await userEvent.type(input, '2')

    await waitFor(() => {
      expect(setWorkspaceRoot).toHaveBeenCalledWith('/current/workspace2')
    })
  })
})
