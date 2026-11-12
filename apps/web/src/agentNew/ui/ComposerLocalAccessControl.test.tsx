import { fireEvent, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithStore } from '../../test/renderWithStore'
import { ComposerLocalAccessControl } from './ComposerLocalAccessControl'

const state = vi.hoisted(() => ({ mode: 'workspace', local: true, setMode: vi.fn() }))
vi.mock('@einfach-agent/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@einfach-agent/core')>(),
  setLocalAccessMode: state.setMode, hasHostBridge: () => state.local,
}))
vi.mock('./ActiveSessionProvider', () => ({
  useActiveSessionConfig: () => ({ id: 'session', localAccessMode: state.mode }),
}))

beforeEach(() => {
  state.mode = 'workspace'
  state.local = true
  state.setMode.mockClear()
})

describe('composer local access dropdown', () => {
  it('shows both choices and sends explicit selection to the session command', () => {
    const view = renderWithStore(<ComposerLocalAccessControl disabled={false} />)
    const select = screen.getByRole('combobox', { name: '本地权限' })
    expect(select).toHaveValue('workspace')
    expect(screen.getByRole('option', { name: '目录内' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '本地完整权限' })).toBeInTheDocument()
    fireEvent.change(select, { target: { value: 'full' } })
    expect(state.setMode).toHaveBeenCalledWith('full')
    state.mode = 'full'
    view.rerender(<ComposerLocalAccessControl disabled={false} />)
    expect(select).toHaveValue('full')
    fireEvent.change(select, { target: { value: 'workspace' } })
    expect(state.setMode).toHaveBeenLastCalledWith('workspace')
  })

  it('disables selection while running', () => {
    renderWithStore(<ComposerLocalAccessControl disabled />)
    expect(screen.getByRole('combobox', { name: '本地权限' })).toBeDisabled()
  })

  it('hides local permissions when no local host is connected', () => {
    state.local = false
    renderWithStore(<ComposerLocalAccessControl disabled={false} />)
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })
})
