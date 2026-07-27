import { beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}))

vi.mock('@tauri-apps/api/core', () => tauri)

import { readWorkspaceFile } from './workspaceRead'

beforeEach(() => {
  vi.clearAllMocks()
  tauri.isTauri.mockReturnValue(true)
})

describe('readWorkspaceFile contentHash', () => {
  it('把后端 snake_case content_hash 归一化为 contentHash', async () => {
    const contentHash = `sha256:${'a'.repeat(64)}`
    tauri.invoke.mockResolvedValue({
      path: 'a.txt',
      content: 'a',
      truncated: false,
      bytes: 1,
      content_hash: contentHash,
    })

    await expect(
      readWorkspaceFile({ path: 'a.txt' }),
    ).resolves.toMatchObject({
      ok: true,
      data: { contentHash },
    })
  })
})
