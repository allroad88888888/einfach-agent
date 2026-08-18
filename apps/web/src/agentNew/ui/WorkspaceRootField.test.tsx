import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithStore } from '../../test/renderWithStore'
import { activeWorkspaceIdAtom, pickWorkspaceDirectory, rootStore, workspacesAtom, setWorkspaceRoot } from '@web-agent/core'
import { WorkspaceRootField } from './WorkspaceRootField'

vi.mock('@web-agent/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@web-agent/core')>()),
  canPickWorkspaceDirectory: vi.fn(() => true),
  pickWorkspaceDirectory: vi.fn(async () => ({ ok: true, path: '/picked/workspace' })),
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

  it('选择目录后写入当前一级工作区', async () => {
    seedActiveSession()
    renderWithStore(<WorkspaceRootField />)

    expect(screen.getByLabelText('工作区目录')).toHaveValue('/current/workspace')
    await userEvent.click(screen.getByRole('button', { name: '选择' }))

    await waitFor(() => {
      expect(pickWorkspaceDirectory).toHaveBeenCalledWith('/current/workspace')
      expect(setWorkspaceRoot).toHaveBeenCalledWith('/picked/workspace')
    })
  })
})
