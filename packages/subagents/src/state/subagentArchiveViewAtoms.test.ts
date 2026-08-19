import { createStore } from '@einfach/core'
import { describe, expect, it } from 'vitest'
import type { ReadWorkspaceFileInput, ReadWorkspaceFileResult, WorkspaceRuntimeResult } from '@einfach-agent/core/subagents'
import {
  loadSubagentArchiveAtom,
  loadSubagentArchivePreviewAtom,
  loadSubagentTraceAtom,
  parseSubagentTrace,
  readSubagentArchive,
  resolveSubagentArchivePath,
  subagentArchiveLoadsAtom,
  subagentArchivePreviewAtom,
  subagentTraceAtom,
} from './subagentViewAtoms'

describe('subagent archive view atoms', () => {
  it('从 tree 与 events 回放完整递归节点', async () => {
    const treeText = JSON.stringify({ nodes: [
      { path: 'root', treeId: 'tree-1', status: 'done', objective: 'root', depth: 0 },
      { path: 'root-01', treeId: 'tree-1', parentPath: 'root', status: 'done', objective: '一级', depth: 1 },
      { path: 'root-01-02', treeId: 'tree-1', parentPath: 'root-01', status: 'failed', objective: '二级', depth: 2, resultFile: '.webAgent-archive/run/results/root-01-02.result.md', error: 'boom' },
    ] })
    const eventsText = `${JSON.stringify({ eventId: 'e1', timestamp: '2026-01-01T00:00:00Z', conversationId: 's1', runId: 'r1', treeId: 'tree-1', agentPath: 'root-01-02', type: 'child_finished', data: { summary: '递归结果' } })}\n`
    const reader = async (input: ReadWorkspaceFileInput): Promise<WorkspaceRuntimeResult<ReadWorkspaceFileResult>> => ({
      ok: true, data: { path: input.path, content: input.path.endsWith('tree.json') ? treeText : eventsText, truncated: false, bytes: 10 },
    })
    const loaded = await readSubagentArchive({ archiveBasePath: '.webAgent-archive/run' }, reader)
    expect(loaded.tree?.nodes.map((node) => [node.path, node.depth])).toEqual([['root', 0], ['root-01', 1], ['root-01-02', 2]])
    expect(loaded.tree?.nodes[2]).toMatchObject({ summary: '递归结果' })
  })

  it('区分缺失归档和读取失败，并安全处理相对路径', async () => {
    await expect(readSubagentArchive({ archiveBasePath: '.webAgent-archive/run' }, async () => ({ ok: false, error: 'file does not exist' }))).resolves.toMatchObject({ status: 'empty' })
    await expect(readSubagentArchive({ archiveBasePath: '.webAgent-archive/run' }, async () => ({ ok: false, error: 'permission denied' }))).resolves.toMatchObject({ status: 'error' })
    expect(resolveSubagentArchivePath('.webAgent-archive/run', 'results/a.md')).toBe('.webAgent-archive/run/results/a.md')
  })

  it('归档请求不会被较早 workspace 的响应覆盖', async () => {
    const store = createStore()
    let resolveOld!: (result: WorkspaceRuntimeResult<ReadWorkspaceFileResult>) => void
    const oldRequest = store.setter(loadSubagentArchiveAtom, {
      archiveBasePath: '.webAgent-archive/run',
      workspaceRoot: '/old',
      reader: (input) => input.path.endsWith('tree.json')
        ? new Promise((resolve) => { resolveOld = resolve })
        : Promise.resolve({ ok: false, error: 'file does not exist' }),
    })
    await store.setter(loadSubagentArchiveAtom, { archiveBasePath: '.webAgent-archive/run', workspaceRoot: '/new', force: true, reader: async (input) => ({ ok: true, data: { path: input.path, content: input.path.endsWith('tree.json') ? JSON.stringify({ nodes: [{ path: 'root', treeId: 'new-tree', status: 'done', objective: 'root', depth: 0 }] }) : '', truncated: false, bytes: 10 } }) })
    resolveOld({ ok: false, error: 'permission denied' })
    await oldRequest
    expect(store.getter(subagentArchiveLoadsAtom)['.webAgent-archive/run']).toMatchObject({ workspaceRoot: '/new', tree: { treeId: 'new-tree' } })
  })

  it('预览与轨迹均拒绝过期读取', async () => {
    const store = createStore()
    let resolvePreview!: (result: WorkspaceRuntimeResult<ReadWorkspaceFileResult>) => void
    const oldPreview = store.setter(loadSubagentArchivePreviewAtom, { archiveBasePath: '.webAgent-archive/run', path: 'old.md', kind: 'result', reader: () => new Promise((resolve) => { resolvePreview = resolve }) })
    await store.setter(loadSubagentArchivePreviewAtom, { archiveBasePath: '.webAgent-archive/run', path: 'new.md', kind: 'result', reader: async (input) => ({ ok: true, data: { path: input.path, content: 'new', truncated: false, bytes: 3 } }) })
    resolvePreview({ ok: true, data: { path: 'old.md', content: 'old', truncated: false, bytes: 3 } })
    await oldPreview
    expect(store.getter(subagentArchivePreviewAtom)).toMatchObject({ content: 'new' })
    const trace = JSON.stringify({ timestamp: '2026-07-23T00:00:01Z', turn: 2, item: { role: 'assistant', content: 'trace' } })
    expect(parseSubagentTrace(`${trace}\n{bad`).warnings).toHaveLength(1)
    await store.setter(loadSubagentTraceAtom, { archiveBasePath: '.webAgent-archive/run', agentPath: 'root-02', nodeKey: 'tree:root-02', reader: async (input) => ({ ok: true, data: { path: input.path, content: trace, truncated: false, bytes: trace.length } }) })
    expect(store.getter(subagentTraceAtom)).toMatchObject({ status: 'ready', nodeKey: 'tree:root-02' })
  })
})
