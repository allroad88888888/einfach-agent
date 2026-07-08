import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithStore } from '../../test/renderWithStore'
import { activeSessionIdAtom, resetRootStore, rootStore, sessionsAtom } from '../state/rootStore'
import { resetSessionStores } from '../state/sessionStore'
import { setWorkspaceRoot } from '../runtime/commands'
import { pickWorkspaceDirectory } from '../runtime/workspaceDialog'
import { WorkspaceRootField } from './WorkspaceRootField'

vi.mock('../runtime/commands', () => ({
  setWorkspaceRoot: vi.fn(),
}))

vi.mock('../runtime/workspaceDialog', () => ({
  canPickWorkspaceDirectory: vi.fn(() => true),
  pickWorkspaceDirectory: vi.fn(async () => ({ ok: true, path: '/picked/workspace' })),
}))

function seedActiveSession(): void {
  rootStore.setter(sessionsAtom, {
    s1: {
      id: 's1',
      title: '会话',
      settings: { vendor: 'deepseek', model: 'x' },
      createdAt: 0,
      updatedAt: 0,
      workspaceRoot: '/current/workspace',
    },
  })
  rootStore.setter(activeSessionIdAtom, 's1')
}

describe('WorkspaceRootField', () => {
  afterEach(() => {
    resetRootStore()
    resetSessionStores()
    vi.clearAllMocks()
  })

  it('选择目录后写入当前会话 workspaceRoot', async () => {
    seedActiveSession()
    renderWithStore(<WorkspaceRootField />, { store: rootStore })

    await userEvent.click(screen.getByRole('button', { name: '选择' }))

    await waitFor(() => {
      expect(pickWorkspaceDirectory).toHaveBeenCalledWith('/current/workspace')
      expect(setWorkspaceRoot).toHaveBeenCalledWith('/picked/workspace')
    })
  })
})
