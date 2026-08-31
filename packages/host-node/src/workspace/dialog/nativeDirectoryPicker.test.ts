import { describe, expect, it, vi } from 'vitest'
import { pickNativeWorkspaceDirectory } from './nativeDirectoryPicker'

describe('pickNativeWorkspaceDirectory', () => {
  it('uses the macOS system chooser and trims its POSIX output', async () => {
    const runAppleScript = vi.fn().mockResolvedValue('/Users/me/project/\n')
    await expect(pickNativeWorkspaceDirectory({ platform: 'darwin', runAppleScript })).resolves.toBe('/Users/me/project/')
    expect(runAppleScript).toHaveBeenCalledWith(expect.stringContaining('choose folder'))
  })

  it('turns a macOS cancellation into an empty selection', async () => {
    await expect(pickNativeWorkspaceDirectory({
      platform: 'darwin',
      runAppleScript: async () => { throw new Error('User canceled. (-128)') },
    })).resolves.toBeUndefined()
  })

  it('fails clearly on a host without Finder instead of pretending a path was selected', async () => {
    await expect(pickNativeWorkspaceDirectory({ platform: 'linux' })).rejects.toThrow('仅支持 macOS')
  })
})
