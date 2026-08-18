import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hostBridgeMock } from './hostTauri.testHarness'

// isTauri 分量已死：nothing 再从 '@tauri-apps/api/core' 读它（D8）。invoke 分量仍在用——
// tauri.invoke 被下面的 './hostBridge' 桥 mock 直接引用，也被本文件的断言直接检查。
const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => tauri)

// H2：workspaceRead / workspaceRg 改用 ./hostBridge 之后，宿主判定读的是 hasHostBridge()、
// invoke 走惰性解析，两者都不再经过上面那份模块 mock。这里把 hostBridge 一并 mock 掉：
// hasHostBridge 恒真、loadHostInvoke 仍然吐同一个 tauri.invoke，既有用例的断言一字不动照旧成立。
// 本文件末尾「rg 桥」用例会 vi.resetModules() 后重新 import('./workspaceRg')——mock 注册本身
// 不受 resetModules 影响，重新 import 时仍会命中这份 hostBridge mock。
vi.mock('./hostBridge', () => hostBridgeMock(async () => tauri.invoke))

import {
  listWorkspaceFiles,
  readWorkspaceFile,
  readWorkspaceRunIndexPage,
  searchWorkspaceFiles,
} from './workspaceRead'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('readWorkspaceRunIndexPage', () => {
  it('映射分页参数并规范化 snake/camel case 响应', async () => {
    tauri.invoke.mockResolvedValue({
      path: '.webAgent-archive/index/runs.jsonl',
      lines: [{ line_number: 99, content: '{"runId":"latest"}' }],
      cursor: 'snapshot:98',
      has_more: true,
      snapshot: 'snapshot',
    })

    await expect(readWorkspaceRunIndexPage({
      cursor: 'snapshot:100', maxRecords: 2, workspaceRoot: '/workspace',
    })).resolves.toEqual({ ok: true, data: {
      path: '.webAgent-archive/index/runs.jsonl',
      lines: [{ lineNumber: 99, content: '{"runId":"latest"}' }],
      cursor: 'snapshot:98',
      hasMore: true,
      snapshot: 'snapshot',
    } })
    expect(tauri.invoke).toHaveBeenCalledWith('read_workspace_run_index_page', {
      cursor: 'snapshot:100', max_records: 2, workspace_root: '/workspace',
    })
  })

  it('拒绝缺少 snapshot 的响应，防止不稳定游标进入状态层', async () => {
    tauri.invoke.mockResolvedValue({ lines: [], hasMore: false })
    await expect(readWorkspaceRunIndexPage({})).resolves.toEqual({
      ok: false, error: 'read_workspace_run_index_page returned an invalid snapshot',
    })
  })
})

describe('Auto external path bridge inputs', () => {
  it('只读文件桥把 runtime-only 外部路径权限映射为 Tauri snake_case 参数', async () => {
    tauri.invoke
      .mockResolvedValueOnce({
        path: '/outside/a.txt',
        content: 'a',
        truncated: false,
        bytes: 1,
      })
      .mockResolvedValueOnce({ entries: [], truncated: false })
      .mockResolvedValueOnce({ matches: [], truncated: false })

    await readWorkspaceFile({
      path: '/outside/a.txt',
      workspaceRoot: '/workspace',
      allowExternalPaths: true,
    })
    await listWorkspaceFiles({
      path: '/outside',
      workspaceRoot: '/workspace',
      allowExternalPaths: true,
    })
    await searchWorkspaceFiles({
      query: 'needle',
      path: '/outside',
      workspaceRoot: '/workspace',
      allowExternalPaths: true,
    })

    expect(tauri.invoke).toHaveBeenNthCalledWith(1, 'read_workspace_file', expect.objectContaining({
      allow_external_paths: true,
    }))
    expect(tauri.invoke).toHaveBeenNthCalledWith(2, 'list_workspace_files', expect.objectContaining({
      allow_external_paths: true,
    }))
    expect(tauri.invoke).toHaveBeenNthCalledWith(3, 'search_workspace_files', expect.objectContaining({
      allow_external_paths: true,
    }))
  })

  it('rg 桥把 runtime-only 外部路径权限映射为 Tauri snake_case 参数', async () => {
    vi.resetModules()
    const { rgSearchWorkspace } = await import('./workspaceRg')
    tauri.invoke.mockResolvedValue({
      ok: true,
      matches: [],
      truncated: false,
      exitCode: 1,
      stderr: '',
    })

    const result = await rgSearchWorkspace({
      query: 'needle',
      path: '../outside',
      workspaceRoot: '/workspace',
      allowExternalPaths: true,
    })

    expect(result.stderr).toBe('')
    expect(tauri.invoke).toHaveBeenCalledWith('rg_search_workspace', expect.objectContaining({
      allow_external_paths: true,
    }))
  })
})
