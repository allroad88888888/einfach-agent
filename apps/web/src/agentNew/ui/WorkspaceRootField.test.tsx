import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithStore } from '../../test/renderWithStore'
import {
  activeWorkspaceIdAtom,
  rootStore,
  workspacesAtom,
} from '@web-agent/core/state/rootStore'
import { setWorkspaceRoot } from '@web-agent/core/runtime/commands'
import { pickWorkspaceDirectory } from '@web-agent/core/runtime/workspaceDialog'
import { WorkspaceRootField } from './WorkspaceRootField'

vi.mock('@web-agent/core/runtime/commands', () => ({
  setWorkspaceRoot: vi.fn(),
}))

vi.mock('@web-agent/core/runtime/workspaceDialog', () => ({
  canPickWorkspaceDirectory: vi.fn(() => true),
  pickWorkspaceDirectory: vi.fn(async () => ({ ok: true, path: '/picked/workspace' })),
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
    renderWithStore(<WorkspaceRootField />, { store: rootStore })

    expect(screen.getByLabelText('工作区目录')).toHaveValue('/current/workspace')
    await userEvent.click(screen.getByRole('button', { name: '选择' }))

    await waitFor(() => {
      expect(pickWorkspaceDirectory).toHaveBeenCalledWith('/current/workspace')
      expect(setWorkspaceRoot).toHaveBeenCalledWith('/picked/workspace')
    })
  })
})
