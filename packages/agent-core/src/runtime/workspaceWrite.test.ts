import { beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}))

vi.mock('@tauri-apps/api/core', () => tauri)

import { writeWorkspaceFile } from './workspaceWrite'

beforeEach(() => {
  vi.clearAllMocks()
  tauri.isTauri.mockReturnValue(true)
})

describe('writeWorkspaceFile', () => {
  it('把 expectedContentHash 映射为 Tauri snake_case 参数', async () => {
    const expectedContentHash = `sha256:${'a'.repeat(64)}`
    tauri.invoke.mockResolvedValue({
      ok: true,
      path: 'a.txt',
      bytes_written: 3,
      created: false,
      overwritten: true,
      appended: false,
    })

    await expect(
      writeWorkspaceFile({
        path: 'a.txt',
        content: 'new',
        mode: 'overwrite',
        expectedContentHash,
      }),
    ).resolves.toMatchObject({ ok: true, overwritten: true })

    expect(tauri.invoke).toHaveBeenCalledWith(
      'write_workspace_file',
      expect.objectContaining({
        path: 'a.txt',
        content: 'new',
        mode: 'overwrite',
        expected_content_hash: expectedContentHash,
      }),
    )
  })
})
