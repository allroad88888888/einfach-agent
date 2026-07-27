import { beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}))

vi.mock('@tauri-apps/api/core', () => tauri)

import {
  listWorkspaceFiles,
  readWorkspaceFile,
  readWorkspaceRunIndexPage,
  searchWorkspaceFiles,
} from './workspaceRead'

beforeEach(() => {
  vi.clearAllMocks()
  tauri.isTauri.mockReturnValue(true)
})

describe('readWorkspaceRunIndexPage', () => {
  it('映射分页参数并规范化 snake/camel case 响应', async () => {
    tauri.invoke.mockResolvedValue({
      path: '.agent-archive/index/runs.jsonl',
      lines: [{ line_number: 99, content: '{"runId":"latest"}' }],
      cursor: 'snapshot:98',
      has_more: true,
      snapshot: 'snapshot',
    })

    await expect(readWorkspaceRunIndexPage({
      cursor: 'snapshot:100', maxRecords: 2, workspaceRoot: '/workspace',
    })).resolves.toEqual({ ok: true, data: {
      path: '.agent-archive/index/runs.jsonl',
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
