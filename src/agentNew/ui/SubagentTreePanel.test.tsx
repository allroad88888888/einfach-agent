import { createStore } from '@einfach/core'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Provider } from '@einfach/react'
import type { ConversationItem } from '@web-agent/core/state/core.type'
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
  const store = createStore()
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
          archiveBasePath: '.agent-archive/conversations/s1/runs/r1',
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
  it('没有对话内 delegate_agent 记录时仍提供 workspace 历史入口', async () => {
    renderPanel([])
    expect(screen.getByRole('region', { name: '子 agent 执行树' })).toBeInTheDocument()
    expect(screen.getByText('workspace 历史')).toBeInTheDocument()
    expect(await screen.findByText('尚无历史 run')).toBeInTheDocument()
  })

  it('展示树节点及可访问状态，点击节点后显示结构化详情', async () => {
    const user = userEvent.setup()
    renderPanel(completedItems())

    expect(screen.getByRole('region', { name: '子 agent 执行树' })).toBeInTheDocument()
    expect(screen.getByText(/归档区回放完整递归树/)).toBeInTheDocument()
    expect(screen.getByText('1 次委派')).toBeInTheDocument()
    const node = screen.getByRole('button', { name: /审查归档 完成/ })
    expect(node).toHaveAttribute('aria-pressed', 'false')

    await user.click(node)

    expect(node).toHaveAttribute('aria-pressed', 'true')
    const detail = screen.getByRole('complementary', { name: '子 agent 节点详情' })
    expect(detail).toHaveTextContent('root-01')
    expect(detail).toHaveTextContent('归档写入正常')
    expect(detail).toHaveTextContent('nodes/root-01/result.md')
    expect(detail).toHaveTextContent('.agent-archive/conversations/s1/runs/r1')
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
      { path: 'root-01-02', treeId: 'tree-1', parentPath: 'root-01', status: 'done', objective: '递归审查', depth: 2, resultFile: '.agent-archive/conversations/s1/runs/r1/results/root-01-02.result.md' },
    ] })
    const eventsText = `${JSON.stringify({
      eventId: 'e1', timestamp: '2026-01-01T00:00:00Z', conversationId: 's1', runId: 'r1', treeId: 'tree-1', agentPath: 'root-01-02', type: 'child_finished',
      data: { status: 'done', objective: '递归审查', summary: '归档中的二级节点', resultFile: '.agent-archive/conversations/s1/runs/r1/results/root-01-02.result.md' },
    })}\n`
    vi.mocked(readWorkspaceFile).mockImplementation(async (input) => {
      if (input.path.endsWith('tree.json')) return { ok: true, data: { path: input.path, content: treeText, truncated: false, bytes: treeText.length } }
      if (input.path.endsWith('events.jsonl')) return { ok: true, data: { path: input.path, content: eventsText, truncated: false, bytes: eventsText.length } }
      return { ok: true, data: { path: input.path, content: '# 完整结果', truncated: false, bytes: 6 } }
    })
    const user = userEvent.setup()

    renderPanel(completedItems())

    const nested = await screen.findByRole('button', { name: '递归审查 完成' })
    await user.click(nested)
    expect(screen.getByRole('complementary', { name: '子 agent 节点详情' })).toHaveTextContent('归档中的二级节点')

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

  it('脱离对话消息列出全局 run，并复用归档树与 result/event 预览', async () => {
    const indexText = JSON.stringify({
      conversationId: 'history-conversation',
      runId: 'history-run',
      status: 'delegated',
      archiveBasePath: '.agent-archive/conversations/history-conversation/runs/history-run',
      eventLog: '.agent-archive/conversations/history-conversation/runs/history-run/events.jsonl',
      updatedAt: '2026-07-21T10:00:00Z',
    })
    const treeText = JSON.stringify({ nodes: [
      { path: 'root', treeId: 'history-run', status: 'done', objective: '历史根任务', depth: 0 },
      { path: 'root-01', treeId: 'history-run', parentPath: 'root', status: 'done', objective: '历史递归任务', depth: 1, resultFile: '.agent-archive/conversations/history-conversation/runs/history-run/results/root-01.result.md' },
    ] })
    const eventsText = `${JSON.stringify({
      eventId: 'history-event', timestamp: '2026-07-21T10:00:00Z', conversationId: 'history-conversation', runId: 'history-run', treeId: 'history-run', agentPath: 'root-01', type: 'child_finished',
      data: { status: 'done', objective: '历史递归任务', summary: '全局历史摘要', resultFile: '.agent-archive/conversations/history-conversation/runs/history-run/results/root-01.result.md' },
    })}\n`
    vi.mocked(readWorkspaceFile).mockImplementation(async (input) => {
      const content = input.path.endsWith('tree.json')
          ? treeText
          : input.path.endsWith('events.jsonl')
            ? eventsText
            : '# 历史结果'
      return { ok: true, data: { path: input.path, content, truncated: false, bytes: content.length } }
    })
    vi.mocked(readWorkspaceRunIndexPage).mockResolvedValue({ ok: true, data: {
      path: '.agent-archive/index/runs.jsonl',
      lines: [{ lineNumber: 1, content: indexText }],
      hasMore: false,
      snapshot: 'history-snapshot',
    } })
    const user = userEvent.setup()

    renderPanel([], '/workspace/history')
    const run = await screen.findByRole('button', { name: /history-run.*history-conversation.*delegated/ })
    await user.click(run)
    const node = await screen.findByRole('button', { name: '历史递归任务 完成' })
    await user.click(node)
    expect(screen.getByRole('complementary', { name: '子 agent 节点详情' })).toHaveTextContent('全局历史摘要')

    await user.click(screen.getByRole('button', { name: '查看结果' }))
    expect(await screen.findByRole('region', { name: '归档文件预览' })).toHaveTextContent('# 历史结果')
    await user.click(screen.getByRole('button', { name: '查看事件日志' }))
    expect(screen.getByRole('region', { name: '归档文件预览' })).toHaveTextContent('history-event')
    expect(vi.mocked(readWorkspaceFile).mock.calls.every(([input]) => input.workspaceRoot === '/workspace/history')).toBe(true)
    expect(vi.mocked(readWorkspaceRunIndexPage).mock.calls.every(([input]) => input.workspaceRoot === '/workspace/history')).toBe(true)
  })

  it('通过 Einfach 分页状态加载更多历史 run，并保留最新重复记录', async () => {
    const record = (runId: string, status: string) => JSON.stringify({
      conversationId: 'paging', runId, status,
      archiveBasePath: `.agent-archive/conversations/paging/runs/${runId}`,
      updatedAt: runId === 'r1' ? '2026-07-22T00:00:00Z' : '2026-07-21T00:00:00Z',
    })
    vi.mocked(readWorkspaceRunIndexPage)
      .mockResolvedValueOnce({ ok: true, data: {
        path: '.agent-archive/index/runs.jsonl',
        lines: [{ lineNumber: 3, content: record('r1', 'done') }],
        cursor: 'snapshot:2', hasMore: true, snapshot: 'snapshot',
      } })
      .mockResolvedValueOnce({ ok: true, data: {
        path: '.agent-archive/index/runs.jsonl',
        lines: [
          { lineNumber: 2, content: record('r2', 'delegated') },
          { lineNumber: 1, content: record('r1', 'running') },
        ],
        hasMore: false, snapshot: 'snapshot',
      } })
    const user = userEvent.setup()

    renderPanel([], '/workspace/paging')
    await screen.findByRole('button', { name: /r1.*paging.*done/ })
    await user.click(screen.getByRole('button', { name: '加载更多历史 run' }))
    expect(await screen.findByRole('button', { name: /r2.*paging.*delegated/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /r1.*paging.*done/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '加载更多历史 run' })).not.toBeInTheDocument()
    expect(vi.mocked(readWorkspaceRunIndexPage).mock.calls[1][0]).toMatchObject({
      cursor: 'snapshot:2', workspaceRoot: '/workspace/paging',
    })
  })

  it('解释 candidate 评分，并经人工确认仅生成尚未执行的治理 CLI', async () => {
    const record = JSON.stringify({
      type: 'skill', skillId: 'sk_review', kind: 'core',
      globalPath: '.agent-archive/skills/sk_review.md',
      contentHash: 'h64:1234567890abcd', promotion: 'candidate',
      inheritSkillIds: [], sourceTranscriptChars: 1_000,
      createdAt: '2026-07-21T00:00:00.000Z', summary: '可复用的归档校验策略',
    })
    vi.mocked(readWorkspaceFile).mockImplementation(async (input) => {
      const content = input.path.endsWith('skills.jsonl')
        ? record
        : '---\nskill_id: "sk_review"\npromotion: "candidate"\n---\n\nbody\n'
      return { ok: true, data: { path: input.path, content, bytes: content.length, truncated: false } }
    })
    const user = userEvent.setup()

    renderPanel([], '/workspace/review')
    const skill = await screen.findByRole('button', { name: /sk_review.*core.*29/ })
    await user.click(skill)
    await user.click(screen.getByText('评分 29/100'))
    expect(screen.getByText('1000 个 transcript 字符，每 250 字符 1 分')).toBeInTheDocument()
    expect(screen.getByText('评分只用于排序和解释，不会自动 promote 或 archive。')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '请求 Archive' }))
    const dialog = screen.getByRole('dialog', { name: '确认 skill 治理操作' })
    expect(dialog).toHaveTextContent('此界面不会静默修改文件')
    expect(dialog).not.toHaveTextContent('操作已生成，尚未执行')
    await user.click(screen.getByRole('button', { name: '确认生成操作' }))

    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('操作已生成，尚未执行')
    expect(status).toHaveTextContent('npm run subagent:skills -- --archive sk_review --write')
    expect(status).not.toHaveTextContent('已归档')
  })
})
