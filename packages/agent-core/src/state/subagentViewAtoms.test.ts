import { createStore } from '@einfach/core'
import { describe, expect, it } from 'vitest'
import type { ConversationItem } from './core.type'
import { itemsAtom } from './sessionAtoms'
import { executionGraphAtom } from '../execution/graph'
import {
  globalSubagentRunsAtom,
  loadGlobalSubagentRunsAtom,
  loadSubagentArchiveAtom,
  loadSubagentArchivePreviewAtom,
  loadSubagentTraceAtom,
  parseGlobalSubagentRunsIndex,
  parseSubagentTrace,
  readSubagentArchive,
  resolveSubagentArchivePath,
  selectedSubagentNodeAtom,
  selectedSubagentNodeKeyAtom,
  subagentArchiveLoadsAtom,
  subagentArchivePreviewAtom,
  subagentTraceAtom,
  subagentTreesAtom,
} from './subagentViewAtoms'
import type {
  ReadWorkspaceFileInput,
  ReadWorkspaceFileResult,
  ReadWorkspaceRunIndexPageResult,
  WorkspaceRuntimeResult,
} from '../runtime/workspaceRead'

function delegateItems(result?: unknown): ConversationItem[] {
  const items: ConversationItem[] = [
    {
      id: 'assistant-1',
      createdAt: 10,
      item: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: {
              name: 'delegate_agent',
              arguments: JSON.stringify({
                strategy: 'parallel_wait_all',
                children: [{ objective: '检查运行时' }, { objective: '补齐测试' }],
              }),
            },
          },
        ],
      },
    },
  ]
  if (result !== undefined) {
    items.push({
      id: 'tool-1',
      createdAt: 11,
      item: { role: 'tool', tool_call_id: 'call-1', content: JSON.stringify(result) },
    })
  }
  return items
}

describe('subagentViewAtoms', () => {
  it('解析全局 run 索引时按逻辑 run 去重、排序并拒绝越界归档路径', () => {
    const parsed = parseGlobalSubagentRunsIndex([
      JSON.stringify({ conversationId: 'c1', runId: 'r1', status: 'running', archiveBasePath: '.agent-archive/conversations/c1/runs/r1', updatedAt: '2026-01-01T00:00:00Z' }),
      '{broken',
      JSON.stringify({ conversationId: 'c2', runId: 'r2', status: 'delegated', archiveBasePath: '../../secret', updatedAt: '2026-01-03T00:00:00Z' }),
      JSON.stringify({ conversationId: 'c4', runId: 'r4', status: 'delegated', archiveBasePath: '.agent-archive/conversations/c4\\..\\secret/runs/r4', updatedAt: '2026-01-05T00:00:00Z' }),
      JSON.stringify({ conversationId: 'c1', runId: 'r1', status: 'delegated', archiveBasePath: '.agent-archive/conversations/c1/runs/r1', updatedAt: '2026-01-02T00:00:00Z' }),
      JSON.stringify({ conversationId: 'c3', runId: 'r3', status: 'delegated', archiveBasePath: '.agent-archive/conversations/c3/runs/r3', updatedAt: '2026-01-04T00:00:00Z' }),
      '',
    ].join('\n'))

    expect(parsed.runs.map((run) => [run.runId, run.status])).toEqual([
      ['r3', 'delegated'],
      ['r1', 'delegated'],
    ])
    expect(parsed.warnings).toHaveLength(3)
  })

  it('全局 run 索引切换 workspace 后不会被旧请求覆盖', async () => {
    const store = createStore()
    let resolveOld!: (result: WorkspaceRuntimeResult<ReadWorkspaceRunIndexPageResult>) => void
    const oldRequest = store.setter(loadGlobalSubagentRunsAtom, {
      workspaceRoot: '/old',
      reader: () => new Promise((resolve) => { resolveOld = resolve }),
    })
    const content = JSON.stringify({
      conversationId: 'new-conversation',
      runId: 'new-run',
      status: 'delegated',
      archiveBasePath: '.agent-archive/conversations/new-conversation/runs/new-run',
    })
    await store.setter(loadGlobalSubagentRunsAtom, {
      workspaceRoot: '/new',
      reader: async () => ({ ok: true, data: {
        path: '.agent-archive/index/runs.jsonl',
        lines: [{ lineNumber: 1, content }],
        hasMore: false,
        snapshot: 'new-snapshot',
      } }),
    })
    resolveOld({ ok: false, error: 'permission denied' })
    await oldRequest

    expect(store.getter(globalSubagentRunsAtom)).toMatchObject({
      workspaceRoot: '/new',
      status: 'ready',
      runs: [expect.objectContaining({ runId: 'new-run' })],
    })
  })

  it('跨页保持最新 append 记录并去重，支持超过通用 200KB 上限的唯一 run', async () => {
    const store = createStore()
    const records = Array.from({ length: 2_000 }, (_, index) => JSON.stringify({
      conversationId: `c-${index}`,
      runId: `r-${index}`,
      status: 'delegated',
      archiveBasePath: `.agent-archive/conversations/c-${index}/runs/r-${index}`,
      updatedAt: new Date(1_700_000_000_000 + index).toISOString(),
      padding: 'x'.repeat(80),
    }))
    expect(records.join('\n').length).toBeGreaterThan(200_000)
    const latestDuplicate = JSON.stringify({
      conversationId: 'c-0', runId: 'r-0', status: 'done',
      archiveBasePath: '.agent-archive/conversations/c-0/runs/r-0',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    let call = 0
    const reader = async () => {
      call += 1
      return call === 1
        ? { ok: true as const, data: { path: '.agent-archive/index/runs.jsonl', lines: [
          { lineNumber: 2_001, content: latestDuplicate },
          { lineNumber: 2_000, content: records[1_999] },
        ], cursor: 'snapshot:1999', hasMore: true, snapshot: 'snapshot' } }
        : { ok: true as const, data: { path: '.agent-archive/index/runs.jsonl', lines: [
          { lineNumber: 1, content: records[0] },
        ], hasMore: false, snapshot: 'snapshot' } }
    }
    await store.setter(loadGlobalSubagentRunsAtom, {
      reader,
    })
    await store.setter(loadGlobalSubagentRunsAtom, { loadMore: true, reader })

    expect(store.getter(globalSubagentRunsAtom)).toMatchObject({
      status: 'ready',
      hasMore: false,
      runs: [
        expect.objectContaining({ runId: 'r-0', status: 'done' }),
        expect.objectContaining({ runId: 'r-1999' }),
      ],
    })
  })

  it('翻页快照变化时 fail-closed，不拼接不同索引版本', async () => {
    const store = createStore()
    const line = JSON.stringify({
      conversationId: 'c1', runId: 'r1',
      archiveBasePath: '.agent-archive/conversations/c1/runs/r1',
    })
    await store.setter(loadGlobalSubagentRunsAtom, { reader: async () => ({ ok: true, data: {
      path: '.agent-archive/index/runs.jsonl', lines: [{ lineNumber: 2, content: line }],
      cursor: 's1:1', hasMore: true, snapshot: 's1',
    } }) })
    await store.setter(loadGlobalSubagentRunsAtom, { loadMore: true, reader: async () => ({ ok: true, data: {
      path: '.agent-archive/index/runs.jsonl', lines: [{ lineNumber: 1, content: line }],
      hasMore: false, snapshot: 's2',
    } }) })

    expect(store.getter(globalSubagentRunsAtom)).toMatchObject({
      status: 'error', runs: [], error: expect.stringContaining('快照已变化'),
    })
  })

  it('工具仍在运行时从调用参数派生稳定的排队节点', () => {
    const store = createStore()
    store.setter(itemsAtom, delegateItems())

    const [tree] = store.getter(subagentTreesAtom)
    expect(tree.status).toBe('running')
    expect(tree.nodes.map((node) => [node.key, node.status, node.objective])).toEqual([
      ['call-1:root', 'running', '委派 2 个子 agent'],
      ['call-1:pending-1', 'queued', '检查运行时'],
      ['call-1:pending-2', 'queued', '补齐测试'],
    ])
  })

  it('旧委派调用失败且没有真实子节点时，不再把占位子节点显示为排队', () => {
    const store = createStore()
    store.setter(itemsAtom, delegateItems({ error: '子 agent 启动失败' }))

    const [tree] = store.getter(subagentTreesAtom)
    expect(tree.status).toBe('failed')
    expect(tree.nodes.map((node) => [node.status, node.error])).toEqual([
      ['failed', '子 agent 启动失败'],
      ['failed', '子 agent 启动失败'],
      ['failed', '子 agent 启动失败'],
    ])
  })

  it('工具结果到达后替换为真实 path、状态和详情，并由选择 atom 派生节点详情', () => {
    const store = createStore()
    store.setter(
      itemsAtom,
      delegateItems({
        treeId: 'tree-1',
        parentPath: 'root',
        strategy: 'parallel_wait_all',
        archiveBasePath: '.agent-archive/runs/r1',
        children: [
          {
            path: 'root-01',
            status: 'done',
            objective: '检查运行时',
            summary: '未发现死锁',
            resultFile: 'nodes/root-01/result.md',
            skillFiles: ['skills/runtime.md'],
            skillIds: ['runtime'],
          },
          {
            path: 'root-01-02',
            status: 'failed',
            objective: '补齐测试',
            summary: '执行失败',
            error: 'timeout',
            skillFiles: [],
            skillIds: [],
          },
        ],
      }),
    )

    const [tree] = store.getter(subagentTreesAtom)
    expect(tree.id).toBe('call-1')
    expect(tree.treeId).toBe('tree-1')
    expect(tree.status).toBe('failed')
    expect(tree.nodes.map((node) => [node.path, node.depth])).toEqual([
      ['root', 0],
      ['root-01', 1],
      ['root-01-02', 2],
    ])

    store.setter(selectedSubagentNodeKeyAtom, 'call-1:root-01-02')
    expect(store.getter(selectedSubagentNodeAtom)?.node).toMatchObject({
      path: 'root-01-02',
      status: 'failed',
      error: 'timeout',
    })
  })

  it('优先展示持久化执行图，并把重启前的活跃子树显示为已中断', () => {
    const store = createStore()
    store.setter(executionGraphAtom, {
      version: 1,
      order: ['run-live:root', 'run-live:root-01'],
      nodes: {
        'run-live:root': {
          id: 'run-live:root',
          graphId: 'run-live',
          sessionId: 'session',
          runId: 'run-live',
          dependsOn: [],
          type: 'agent',
          status: 'interrupted',
          label: 'root agent',
          attempt: 1,
          generation: 1,
          effectKeys: [],
          createdAt: 10,
          updatedAt: 20,
          result: { path: 'root' },
        },
        'run-live:root-01': {
          id: 'run-live:root-01',
          graphId: 'run-live',
          sessionId: 'session',
          runId: 'run-live',
          parentId: 'run-live:root',
          dependsOn: [],
          type: 'agent',
          status: 'succeeded',
          label: '检查运行时',
          attempt: 1,
          generation: 1,
          effectKeys: [],
          createdAt: 11,
          updatedAt: 19,
          result: { path: 'root-01' },
        },
      },
    })
    store.setter(itemsAtom, delegateItems())

    const [tree] = store.getter(subagentTreesAtom)
    expect(tree.treeId).toBe('run-live')
    expect(tree.status).toBe('interrupted')
    expect(tree.nodes.map((node) => [node.path, node.status])).toEqual([
      ['root', 'interrupted'],
      ['root-01', 'done'],
    ])
  })

  it('按触发 delegate_agent 的 tool call 拆分执行图，并直接携带会话内模型轨迹', () => {
    const store = createStore()
    store.setter(executionGraphAtom, {
      version: 1,
      order: ['run:root-01', 'run:root-02'],
      nodes: {
        'run:root-01': {
          id: 'run:root-01',
          graphId: 'run',
          sessionId: 'session',
          runId: 'run',
          dependsOn: [],
          type: 'agent',
          status: 'succeeded',
          label: '检查运行时',
          attempt: 1,
          generation: 1,
          effectKeys: [],
          createdAt: 10,
          updatedAt: 12,
          result: { path: 'root-01', delegationCallId: 'delegate-a' },
          trace: [{
            timestamp: '2026-07-23T05:00:00.000Z',
            turn: 1,
            item: {
              role: 'assistant',
              content: '已完成检查',
              reasoning_content: '先读取运行时',
            },
          }],
        },
        'run:root-02': {
          id: 'run:root-02',
          graphId: 'run',
          sessionId: 'session',
          runId: 'run',
          dependsOn: [],
          type: 'agent',
          status: 'running',
          label: '补齐测试',
          attempt: 1,
          generation: 1,
          effectKeys: [],
          createdAt: 20,
          updatedAt: 21,
          result: { path: 'root-02', delegationCallId: 'delegate-b' },
        },
      },
    })

    const trees = store.getter(subagentTreesAtom)
    expect(trees.map((tree) => [tree.callId, tree.nodes.map((node) => node.path)])).toEqual([
      ['delegate-b', ['root-02']],
      ['delegate-a', ['root-01']],
    ])
    expect(trees[1].nodes[0].trace).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({
          reasoning_content: '先读取运行时',
          content: '已完成检查',
        }),
      }),
    ])
  })

  it('把缺少 delegationCallId 的旧执行节点重新关联到原始委派调用', () => {
    const store = createStore()
    store.setter(itemsAtom, delegateItems({
      treeId: 'legacy-run',
      children: [
        { path: 'root-01', status: 'done', objective: '检查运行时' },
        { path: 'root-02', status: 'done', objective: '补齐测试' },
      ],
    }))
    store.setter(executionGraphAtom, {
      version: 1,
      order: ['legacy-run:root', 'legacy-run:root-01', 'legacy-run:root-02'],
      nodes: {
        'legacy-run:root': {
          id: 'legacy-run:root',
          graphId: 'legacy-run',
          sessionId: 'session',
          runId: 'legacy-run',
          dependsOn: [],
          type: 'agent',
          status: 'succeeded',
          label: 'root agent',
          attempt: 1,
          generation: 1,
          effectKeys: [],
          createdAt: 9,
          updatedAt: 12,
          result: { path: 'root' },
        },
        'legacy-run:root-01': {
          id: 'legacy-run:root-01',
          graphId: 'legacy-run',
          sessionId: 'session',
          runId: 'legacy-run',
          parentId: 'legacy-run:root',
          dependsOn: [],
          type: 'agent',
          status: 'succeeded',
          label: '检查运行时',
          attempt: 1,
          generation: 1,
          effectKeys: [],
          createdAt: 10,
          updatedAt: 12,
          result: { path: 'root-01' },
        },
        'legacy-run:root-02': {
          id: 'legacy-run:root-02',
          graphId: 'legacy-run',
          sessionId: 'session',
          runId: 'legacy-run',
          parentId: 'legacy-run:root',
          dependsOn: [],
          type: 'agent',
          status: 'succeeded',
          label: '补齐测试',
          attempt: 1,
          generation: 1,
          effectKeys: [],
          createdAt: 10,
          updatedAt: 12,
          result: { path: 'root-02' },
        },
      },
    })

    const trees = store.getter(subagentTreesAtom)
    expect(trees).toHaveLength(1)
    expect(trees[0].callId).toBe('call-1')
    expect(trees[0].nodes.map((node) => node.path)).toEqual(['root', 'root-01', 'root-02'])
  })

  it('忽略 malformed JSON 和非 delegate 工具调用', () => {
    const store = createStore()
    store.setter(itemsAtom, [
      {
        id: 'a1',
        createdAt: 1,
        item: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'bad',
              type: 'function',
              function: { name: 'delegate_agent', arguments: '{broken' },
            },
            {
              id: 'other',
              type: 'function',
              function: { name: 'read_file', arguments: '{}' },
            },
          ],
        },
      },
    ])

    expect(store.getter(subagentTreesAtom)).toEqual([
      expect.objectContaining({ id: 'bad', nodes: [expect.objectContaining({ path: 'root' })] }),
    ])
  })

  it('从 tree + events 归档回放完整递归节点和 result 入口', async () => {
    const treeText = JSON.stringify({ nodes: [
      { path: 'root', treeId: 'tree-1', status: 'done', objective: 'root', depth: 0 },
      { path: 'root-01', treeId: 'tree-1', parentPath: 'root', status: 'done', objective: '一级', depth: 1 },
      { path: 'root-01-02', treeId: 'tree-1', parentPath: 'root-01', status: 'failed', objective: '二级', depth: 2, resultFile: '.agent-archive/run/results/root-01-02.result.md', error: 'boom' },
    ] })
    const eventsText = `${JSON.stringify({
      eventId: 'e1', timestamp: '2026-01-01T00:00:00Z', conversationId: 's1', runId: 'r1', treeId: 'tree-1', agentPath: 'root-01-02', type: 'child_finished',
      data: { status: 'failed', objective: '二级', summary: '递归结果', resultFile: '.agent-archive/run/results/root-01-02.result.md', error: 'boom' },
    })}\n`
    const reader = async (input: ReadWorkspaceFileInput): Promise<WorkspaceRuntimeResult<ReadWorkspaceFileResult>> => ({
      ok: true,
      data: { path: input.path, content: input.path.endsWith('tree.json') ? treeText : eventsText, truncated: false, bytes: 10 },
    })

    const loaded = await readSubagentArchive({ archiveBasePath: '.agent-archive/run', workspaceRoot: '/workspace' }, reader)

    expect(loaded.status).toBe('ready')
    expect(loaded.tree?.treeId).toBe('tree-1')
    expect(loaded.tree?.nodes.map((node) => [node.path, node.depth])).toEqual([
      ['root', 0],
      ['root-01', 1],
      ['root-01-02', 2],
    ])
    expect(loaded.tree?.nodes[2]).toMatchObject({ summary: '递归结果', resultFile: '.agent-archive/run/results/root-01-02.result.md' })
  })

  it('区分无归档和读取失败，并安全解析归档内相对入口', async () => {
    const missing = await readSubagentArchive(
      { archiveBasePath: '.agent-archive/run' },
      async () => ({ ok: false, error: 'file does not exist' }),
    )
    const failed = await readSubagentArchive(
      { archiveBasePath: '.agent-archive/run' },
      async () => ({ ok: false, error: 'permission denied' }),
    )

    expect(missing.status).toBe('empty')
    expect(failed.status).toBe('error')
    expect(resolveSubagentArchivePath('.agent-archive/run', 'results/a.md')).toBe('.agent-archive/run/results/a.md')
    expect(resolveSubagentArchivePath('.agent-archive/run', '.agent-archive/run/events.jsonl')).toBe('.agent-archive/run/events.jsonl')
  })

  it('同一归档的新 workspace 请求完成后不被旧请求覆盖', async () => {
    const store = createStore()
    let resolveOld!: (result: WorkspaceRuntimeResult<ReadWorkspaceFileResult>) => void
    const oldResult = new Promise<WorkspaceRuntimeResult<ReadWorkspaceFileResult>>((resolve) => {
      resolveOld = resolve
    })
    const oldReader = () => oldResult
    const newTree = JSON.stringify({ nodes: [
      { path: 'root', treeId: 'new-tree', status: 'done', objective: 'new root', depth: 0 },
    ] })
    const newReader = async (input: ReadWorkspaceFileInput): Promise<WorkspaceRuntimeResult<ReadWorkspaceFileResult>> => ({
      ok: true,
      data: {
        path: input.path,
        content: input.path.endsWith('tree.json') ? newTree : '',
        truncated: false,
        bytes: newTree.length,
      },
    })

    const oldRequest = store.setter(loadSubagentArchiveAtom, {
      archiveBasePath: '.agent-archive/run',
      workspaceRoot: '/old',
      reader: oldReader,
    })
    await store.setter(loadSubagentArchiveAtom, {
      archiveBasePath: '.agent-archive/run',
      workspaceRoot: '/new',
      force: true,
      reader: newReader,
    })
    resolveOld({ ok: false, error: 'permission denied' })
    await oldRequest

    expect(store.getter(subagentArchiveLoadsAtom)['.agent-archive/run']).toMatchObject({
      workspaceRoot: '/new',
      status: 'ready',
      tree: { treeId: 'new-tree' },
    })
  })

  it('后选文件预览完成后不被先前的慢读取覆盖', async () => {
    const store = createStore()
    let resolveOld!: (result: WorkspaceRuntimeResult<ReadWorkspaceFileResult>) => void
    const oldReader = () => new Promise<WorkspaceRuntimeResult<ReadWorkspaceFileResult>>((resolve) => {
      resolveOld = resolve
    })
    const newReader = async (input: ReadWorkspaceFileInput): Promise<WorkspaceRuntimeResult<ReadWorkspaceFileResult>> => ({
      ok: true,
      data: { path: input.path, content: 'new content', truncated: false, bytes: 11 },
    })

    const oldRequest = store.setter(loadSubagentArchivePreviewAtom, {
      archiveBasePath: '.agent-archive/run',
      path: 'results/old.md',
      kind: 'result',
      reader: oldReader,
    })
    await store.setter(loadSubagentArchivePreviewAtom, {
      archiveBasePath: '.agent-archive/run',
      path: 'results/new.md',
      kind: 'result',
      reader: newReader,
    })
    resolveOld({
      ok: true,
      data: { path: '.agent-archive/run/results/old.md', content: 'old content', truncated: false, bytes: 11 },
    })
    await oldRequest

    expect(store.getter(subagentArchivePreviewAtom)).toMatchObject({
      status: 'ready',
      kind: 'result',
      path: '.agent-archive/run/results/new.md',
      content: 'new content',
    })
  })

  it('按节点解析并加载完整模型与工具轨迹', async () => {
    const store = createStore()
    const content = [
      JSON.stringify({
        timestamp: '2026-07-23T00:00:00Z',
        turn: 1,
        item: {
          role: 'assistant',
          content: null,
          reasoning_content: '先检查实现',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' },
          }],
        },
      }),
      '{broken',
      JSON.stringify({
        timestamp: '2026-07-23T00:00:01Z',
        turn: 1,
        item: { role: 'tool', tool_call_id: 'call-1', content: '{"content":"source"}' },
      }),
    ].join('\n')

    const parsed = parseSubagentTrace(content)
    expect(parsed.records).toHaveLength(2)
    expect(parsed.warnings).toHaveLength(1)

    await store.setter(loadSubagentTraceAtom, {
      archiveBasePath: '.agent-archive/run',
      agentPath: 'root-01',
      nodeKey: 'tree:root-01',
      workspaceRoot: '/workspace',
      reader: async (input) => ({
        ok: true,
        data: { path: input.path, content, truncated: false, bytes: content.length },
      }),
    })

    expect(store.getter(subagentTraceAtom)).toMatchObject({
      status: 'ready',
      path: '.agent-archive/run/traces/root-01.trace.jsonl',
      nodeKey: 'tree:root-01',
      records: [
        { turn: 1, item: { role: 'assistant', reasoning_content: '先检查实现' } },
        { turn: 1, item: { role: 'tool', tool_call_id: 'call-1' } },
      ],
    })
  })

  it('后选节点轨迹完成后不被先前的慢读取覆盖', async () => {
    const store = createStore()
    let resolveOld!: (result: WorkspaceRuntimeResult<ReadWorkspaceFileResult>) => void
    const oldReader = () => new Promise<WorkspaceRuntimeResult<ReadWorkspaceFileResult>>((resolve) => {
      resolveOld = resolve
    })
    const newContent = JSON.stringify({
      timestamp: '2026-07-23T00:00:01Z',
      turn: 2,
      item: { role: 'assistant', content: 'new trace' },
    })

    const oldRequest = store.setter(loadSubagentTraceAtom, {
      archiveBasePath: '.agent-archive/run',
      agentPath: 'root-01',
      nodeKey: 'tree:root-01',
      reader: oldReader,
    })
    await store.setter(loadSubagentTraceAtom, {
      archiveBasePath: '.agent-archive/run',
      agentPath: 'root-02',
      nodeKey: 'tree:root-02',
      reader: async (input) => ({
        ok: true,
        data: { path: input.path, content: newContent, truncated: false, bytes: newContent.length },
      }),
    })
    resolveOld({ ok: false, error: 'permission denied' })
    await oldRequest

    expect(store.getter(subagentTraceAtom)).toMatchObject({
      status: 'ready',
      path: '.agent-archive/run/traces/root-02.trace.jsonl',
      nodeKey: 'tree:root-02',
      records: [expect.objectContaining({ turn: 2, item: { role: 'assistant', content: 'new trace' } })],
    })
  })
})
