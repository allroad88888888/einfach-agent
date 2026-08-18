import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hostBridgeMock } from './hostTauri.testHarness'

// isTauri 分量已死：nothing 再从 '@tauri-apps/api/core' 读它（D8）。invoke 分量仍在用——
// tauri.invoke 被下面的 './hostBridge' 桥 mock 直接引用，也被本文件的断言直接检查。
const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => tauri)

// H2：workspaceRead 改用 ./hostBridge 之后，宿主判定读的是 hasHostBridge()、invoke 走惰性动态
// 解析，两者都不再经过上面那份模块 mock。这里把 hostBridge 一并 mock 掉：hasHostBridge 恒真、
// loadHostInvoke 仍然吐同一个 tauri.invoke，既有用例的断言一字不动照旧成立。
vi.mock('./hostBridge', () => hostBridgeMock(async () => tauri.invoke))

import { readWorkspaceFile } from './workspaceRead'

beforeEach(() => {
  vi.clearAllMocks()
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

  it('映射 byte offset 并规范化分段读取元数据', async () => {
    tauri.invoke.mockResolvedValue({
      path: 'large.txt',
      content: 'next',
      truncated: true,
      bytes: 4,
      offset: 20_000,
      total_bytes: 40_000,
      next_offset: 20_004,
    })

    await expect(
      readWorkspaceFile({ path: 'large.txt', maxBytes: 4, offset: 20_000 }),
    ).resolves.toEqual({
      ok: true,
      data: {
        path: 'large.txt',
        content: 'next',
        truncated: true,
        bytes: 4,
        offset: 20_000,
        totalBytes: 40_000,
        nextOffset: 20_004,
      },
    })
    expect(tauri.invoke).toHaveBeenCalledWith('read_workspace_file', expect.objectContaining({
      path: 'large.txt',
      max_bytes: 4,
      offset: 20_000,
    }))
  })
})
