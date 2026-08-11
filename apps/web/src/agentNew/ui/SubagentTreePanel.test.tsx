import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Provider } from '@einfach/react'
import type { ConversationItem, SessionMeta } from '@web-agent/core/state/core.type'
import { defaultCore } from '@web-agent/core/runtime/core/coreInstance'
import { activeSessionIdAtom, sessionsAtom } from '@web-agent/core/state/rootStore'
import { itemsAtom } from '@web-agent/core/state/sessionAtoms'
import { SubagentTreePanel } from './SubagentTreePanel'
import { readWorkspaceFile, readWorkspaceRunIndexPage } from '@web-agent/core/runtime/workspaceRead'

vi.mock('@web-agent/core/runtime/workspaceRead', () => ({
  readWorkspaceFile: vi.fn(),
  readWorkspaceRunIndexPage: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(readWorkspaceFile).mockResolvedValue({ ok: false, error: 'file does not exist' })
  vi.mocked(readWorkspaceRunIndexPage).mockResolvedValue({ ok: false, error: 'file does not exist' })
})

function renderPanel(items: ConversationItem[], workspaceRoot?: string) {
  const sessionId = 'subagent-tree-panel'
  const session: SessionMeta = {
    id: sessionId,
    title: '子 Agent 运行记录',
    settings: { vendor: 'deepseek', model: 'deepseek-chat' },
    createdAt: 0,
    updatedAt: 0,
  }
  defaultCore.rootStore.setter(sessionsAtom, { [sessionId]: session })
  defaultCore.rootStore.setter(activeSessionIdAtom, sessionId)
  const store = defaultCore.createSessionStore(sessionId).store
  store.setter(itemsAtom, items)
  return render(
    <Provider store={store}>
      <SubagentTreePanel workspaceRoot={workspaceRoot} />
    </Provider>,
  )
}

function completedItems(): ConversationItem[] {
  return [
    {
      id: 'a1',
      createdAt: 1,
      item: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'delegate-1',
            type: 'function',
            function: {
              name: 'delegate_agent',
              arguments: '{"children":[{"objective":"审查归档"}]}',
            },
          },
        ],
      },
    },
    {
      id: 't1',
      createdAt: 2,
      item: {
        role: 'tool',
        tool_call_id: 'delegate-1',
        content: JSON.stringify({
          treeId: 'tree-1',
          parentPath: 'root',
          archiveBasePath: '.webAgent-archive/conversations/s1/runs/r1',
          children: [
            {
              path: 'root-01',
              status: 'done',
              objective: '审查归档',
              summary: '归档写入正常',
              resultFile: 'nodes/root-01/result.md',
              skillFiles: ['skills/archive.md'],
              skillIds: ['archive'],
            },
          ],
        }),
      },
    },
  ]
}

describe('SubagentTreePanel', () => {
  it('没有实际调用 delegate_agent 时不显示运行记录，也不读取历史', () => {
    renderPanel([])
    expect(screen.queryByText('子 agent 运行记录')).not.toBeInTheDocument()
    expect(readWorkspaceRunIndexPage).not.toHaveBeenCalled()
  })

  it('实际调用后显示默认收起的摘要，展开并点击节点后显示结构化详情', async () => {
    const user = userEvent.setup()
    renderPanel(completedItems())

    const summary = screen.getByText('子 agent 运行记录').closest('summary')
    expect(summary).not.toBeNull()
    expect(summary?.parentElement).not.toHaveAttribute('open')
    expect(screen.getByText('1 次委派')).toBeInTheDocument()
    await user.click(summary!)
    expect(summary?.parentElement).toHaveAttribute('open')
    const node = screen.getByRole('button', { name: /审查归档 完成/ })
    expect(node).toHaveAttribute('aria-pressed', 'false')

    await user.click(node)

    expect(node).toHaveAttribute('aria-pressed', 'true')
    const detail = screen.getByRole('complementary', { name: '子 agent 节点详情' })
    expect(detail).toHaveTextContent('root-01')
    expect(detail).toHaveTextContent('归档写入正常')
    expect(detail).toHaveTextContent('nodes/root-01/result.md')
    expect(detail).toHaveTextContent('.webAgent-archive/conversations/s1/runs/r1')
    expect(detail).toHaveTextContent('技能产物：1')
  })

  it('结果未返回时展示运行中的根节点和排队任务', () => {
    renderPanel(completedItems().slice(0, 1))

    expect(screen.getByRole('button', { name: /委派 1 个子 agent 运行中/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /审查归档 排队/ })).toBeInTheDocument()
  })

  it('同一 treeId 的两个 delegate 批次使用 callId 隔离 key 和节点选择', async () => {
    const user = userEvent.setup()
    const first = completedItems()
    const second: ConversationItem[] = [
      {
        id: 'a2',
        createdAt: 3,
        item: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'delegate-2',
              type: 'function',
              function: {
                name: 'delegate_agent',
                arguments: '{"children":[{"objective":"审查回放"}]}',
              },
            },
          ],
        },
      },
      {
        id: 't2',
        createdAt: 4,
        item: {
          role: 'tool',
          tool_call_id: 'delegate-2',
          content: JSON.stringify({
            treeId: 'tree-1',
            parentPath: 'root',
            children: [
              {
                path: 'root-01',
                status: 'failed',
                objective: '审查回放',
                summary: '第二批次详情',
                error: 'replay failed',
                skillFiles: [],
                skillIds: [],
              },
            ],
          }),
        },
      },
    ]

    renderPanel([...first, ...second])

    expect(screen.getByText('2 次委派')).toBeInTheDocument()
    expect(screen.getByText('delegate-1').parentElement).toHaveTextContent('批次 delegate-1 · tree tree-1')
    expect(screen.getByText('delegate-2').parentElement).toHaveTextContent('批次 delegate-2 · tree tree-1')
    const roots = screen.getAllByRole('button', { name: /委派 1 个子 agent/ })
    expect(roots).toHaveLength(2)

    const firstNode = screen.getByRole('button', { name: '审查归档 完成' })
    const secondNode = screen.getByRole('button', { name: '审查回放 失败' })
    await user.click(firstNode)
    expect(firstNode).toHaveAttribute('aria-pressed', 'true')
    expect(secondNode).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('complementary', { name: '子 agent 节点详情' })).toHaveTextContent(
      '归档写入正常',
    )

    await user.click(secondNode)
    expect(firstNode).toHaveAttribute('aria-pressed', 'false')
    expect(secondNode).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('complementary', { name: '子 agent 节点详情' })).toHaveTextContent(
      '第二批次详情',
    )
  })

  it('归档读取完成后展示递归节点，并可查看 result/event 内容', async () => {
    const treeText = JSON.stringify({ nodes: [
      { path: 'root', treeId: 'tree-1', status: 'done', objective: 'root', depth: 0 },
      { path: 'root-01', treeId: 'tree-1', parentPath: 'root', status: 'done', objective: '一级', depth: 1 },
      { path: 'root-01-02', treeId: 'tree-1', parentPath: 'root-01', status: 'done', objective: '递归审查', depth: 2, resultFile: '.webAgent-archive/conversations/s1/runs/r1/results/root-01-02.result.md' },
    ] })
    const eventsText = `${JSON.stringify({
      eventId: 'e1', timestamp: '2026-01-01T00:00:00Z', conversationId: 's1', runId: 'r1', treeId: 'tree-1', agentPath: 'root-01-02', type: 'child_finished',
      data: { status: 'done', objective: '递归审查', summary: '归档中的二级节点', resultFile: '.webAgent-archive/conversations/s1/runs/r1/results/root-01-02.result.md' },
    })}\n`
    const traceText = [
      JSON.stringify({
        timestamp: '2026-01-01T00:00:01Z',
        turn: 1,
        item: {
          role: 'assistant',
          content: '我先读取目标文件。',
          reasoning_content: '需要核对归档写入路径。',
          tool_calls: [{
            id: 'read-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"src/archive.ts"}' },
          }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-01-01T00:00:02Z',
        turn: 1,
        item: { role: 'tool', tool_call_id: 'read-1', content: '{"content":"archive source"}' },
      }),
      JSON.stringify({
        timestamp: '2026-01-01T00:00:03Z',
        turn: 2,
        item: { role: 'assistant', content: '归档实现完整。', reasoning_content: '工具结果符合预期。', tool_calls: [] },
      }),
    ].join('\n')
    vi.mocked(readWorkspaceFile).mockImplementation(async (input) => {
      if (input.path.endsWith('tree.json')) return { ok: true, data: { path: input.path, content: treeText, truncated: false, bytes: treeText.length } }
      if (input.path.endsWith('events.jsonl')) return { ok: true, data: { path: input.path, content: eventsText, truncated: false, bytes: eventsText.length } }
      if (input.path.endsWith('.trace.jsonl')) return { ok: true, data: { path: input.path, content: traceText, truncated: false, bytes: traceText.length } }
      return { ok: true, data: { path: input.path, content: '# 完整结果', truncated: false, bytes: 6 } }
    })
    const user = userEvent.setup()

    renderPanel(completedItems())

    const nested = await screen.findByRole('button', { name: '递归审查 完成' })
    await user.click(nested)
    expect(screen.getByRole('complementary', { name: '子 agent 节点详情' })).toHaveTextContent('归档中的二级节点')
    const trace = await screen.findByRole('region', { name: '子 agent 完整运行轨迹' })
    expect(trace).toHaveTextContent('模型 thinking')
    expect(trace).toHaveTextContent('read_file')
    expect(trace).toHaveTextContent('最终回复')
    expect(trace).toHaveTextContent('归档实现完整')
    await user.click(screen.getByText('模型 thinking').closest('summary')!)
    expect(trace).toHaveTextContent('需要核对归档写入路径')
    await user.click(screen.getByText('工具结果').closest('summary')!)
    expect(trace).toHaveTextContent('archive source')

    await user.click(screen.getByRole('button', { name: '查看结果' }))
    expect(await screen.findByRole('region', { name: '归档文件预览' })).toHaveTextContent('# 完整结果')

    await user.click(screen.getByRole('button', { name: '查看事件日志' }))
    expect(screen.getByRole('region', { name: '归档文件预览' })).toHaveTextContent('child_finished')

    await user.click(screen.getByRole('button', { name: 'root 完成' }))
    expect(screen.queryByRole('region', { name: '归档文件预览' })).not.toBeInTheDocument()
  })

  it('归档不存在时保留实时批次并展示无归档状态', async () => {
    renderPanel(completedItems())
    expect(await screen.findByText(/暂无归档：.*does not exist/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '审查归档 完成' })).toBeInTheDocument()
  })

})
