import { beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}))

vi.mock('@tauri-apps/api/core', () => tauri)

import { readWorkspaceRunIndexPage } from './workspaceRead'

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
