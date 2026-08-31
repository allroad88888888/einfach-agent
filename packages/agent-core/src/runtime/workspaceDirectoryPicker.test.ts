import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureHostInvoke } from './hostBridge'
import { canPickWorkspaceDirectory, pickWorkspaceDirectory } from './workspaceDirectoryPicker'

afterEach(() => configureHostInvoke(undefined))

describe('workspace directory picker', () => {
  it('does not claim a native picker before the host bridge is assembled', async () => {
    expect(canPickWorkspaceDirectory()).toBe(false)
    await expect(pickWorkspaceDirectory()).resolves.toEqual({
      ok: false,
      error: '当前宿主不支持选择本机文件夹。',
    })
  })

  it('returns a host-selected directory and treats cancellation as no selection', async () => {
    const invoke = vi.fn()
      .mockResolvedValueOnce({ path: '/Users/me/project' })
      .mockResolvedValueOnce({ path: null })
    configureHostInvoke({ loader: async () => invoke, platform: 'macos' })

    expect(canPickWorkspaceDirectory()).toBe(true)
    await expect(pickWorkspaceDirectory()).resolves.toEqual({ ok: true, path: '/Users/me/project' })
    await expect(pickWorkspaceDirectory()).resolves.toEqual({ ok: true })
    expect(invoke).toHaveBeenNthCalledWith(1, 'pick_workspace_directory')
  })

  it('shows the host failure instead of changing the workspace to a guessed path', async () => {
    configureHostInvoke({
      loader: async () => async () => { throw new Error('Finder 无法打开') },
      platform: 'macos',
    })

    await expect(pickWorkspaceDirectory()).resolves.toEqual({ ok: false, error: 'Finder 无法打开' })
  })
})
