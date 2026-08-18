import { Provider } from '@einfach/react'
import { AgentStoreProvider } from '@web-agent/react-plugin'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type ConversationItem,
  type SessionMeta,
  defaultCore,
  activeSessionIdAtom,
  sessionsAtom,
  itemsAtom,
} from '@web-agent/core'
import { readWorkspaceFile, readWorkspaceRunIndexPage } from '@web-agent/core/runtime/workspaceRead'
import { SubagentTreePanel } from './SubagentTreePanel'

vi.mock('@web-agent/core/runtime/workspaceRead', () => ({
  readWorkspaceFile: vi.fn(),
  readWorkspaceRunIndexPage: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(readWorkspaceFile).mockResolvedValue({ ok: false, error: 'file does not exist' })
  vi.mocked(readWorkspaceRunIndexPage).mockResolvedValue({ ok: false, error: 'file does not exist' })
})

function renderPanel(workspaceRoot: string) {
  const sessionId = 'subagent-tree-history'
  const session: SessionMeta = {
    id: sessionId,
    title: '子 Agent 历史',
    settings: { vendor: 'deepseek', model: 'deepseek-chat' },
    createdAt: 0,
    updatedAt: 0,
  }
  const items: ConversationItem[] = [{
    id: 'a1',
    createdAt: 1,
    item: {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'delegate-1',
        type: 'function',
        function: { name: 'delegate_agent', arguments: '{"children":[{"objective":"审查归档"}]}' },
      }],
    },
  }]
  defaultCore.rootStore.setter(sessionsAtom, { [sessionId]: session })
  defaultCore.rootStore.setter(activeSessionIdAtom, sessionId)
  const store = defaultCore.createSessionStore(sessionId).store
  store.setter(itemsAtom, items)
  // 子 Agent 视图 atom 从 executionGraph/items 派生，整族住 agent store —— 两层都绑同一个
  // 会话 store，与 ActiveSessionProvider 生产装配一致（那里 UI store 是另一个实例）。
  return render(
    <Provider store={store}>
      <AgentStoreProvider store={store}><SubagentTreePanel workspaceRoot={workspaceRoot} /></AgentStoreProvider>
    </Provider>,
  )
}

describe('SubagentTreePanel workspace history', () => {
  it('脱离对话消息列出全局 run，并复用归档树与 result/event 预览', async () => {
    const indexText = JSON.stringify({
      conversationId: 'history-conversation', runId: 'history-run', status: 'delegated',
      archiveBasePath: '.webAgent-archive/conversations/history-conversation/runs/history-run',
      eventLog: '.webAgent-archive/conversations/history-conversation/runs/history-run/events.jsonl',
      updatedAt: '2026-07-21T10:00:00Z',
    })
    const treeText = JSON.stringify({ nodes: [
      { path: 'root', treeId: 'history-run', status: 'done', objective: '历史根任务', depth: 0 },
      { path: 'root-01', treeId: 'history-run', parentPath: 'root', status: 'done', objective: '历史递归任务', depth: 1, resultFile: '.webAgent-archive/conversations/history-conversation/runs/history-run/results/root-01.result.md' },
    ] })
    const eventsText = `${JSON.stringify({
      eventId: 'history-event', timestamp: '2026-07-21T10:00:00Z', conversationId: 'history-conversation', runId: 'history-run', treeId: 'history-run', agentPath: 'root-01', type: 'child_finished',
      data: { status: 'done', objective: '历史递归任务', summary: '全局历史摘要', resultFile: '.webAgent-archive/conversations/history-conversation/runs/history-run/results/root-01.result.md' },
    })}\n`
    vi.mocked(readWorkspaceFile).mockImplementation(async (input) => {
      const content = input.path.endsWith('tree.json') ? treeText : input.path.endsWith('events.jsonl') ? eventsText : '# 历史结果'
      return { ok: true, data: { path: input.path, content, truncated: false, bytes: content.length } }
    })
    vi.mocked(readWorkspaceRunIndexPage).mockResolvedValue({ ok: true, data: {
      path: '.webAgent-archive/index/runs.jsonl', lines: [{ lineNumber: 1, content: indexText }], hasMore: false, snapshot: 'history-snapshot',
    } })
    const user = userEvent.setup()

    renderPanel('/workspace/history')
    await user.click(await screen.findByRole('button', { name: /history-run.*history-conversation.*delegated/ }))
    await user.click(await screen.findByRole('button', { name: '历史递归任务 完成' }))
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
      conversationId: 'paging', runId, status, archiveBasePath: `.webAgent-archive/conversations/paging/runs/${runId}`,
      updatedAt: runId === 'r1' ? '2026-07-22T00:00:00Z' : '2026-07-21T00:00:00Z',
    })
    vi.mocked(readWorkspaceRunIndexPage)
      .mockResolvedValueOnce({ ok: true, data: { path: '.webAgent-archive/index/runs.jsonl', lines: [{ lineNumber: 3, content: record('r1', 'done') }], cursor: 'snapshot:2', hasMore: true, snapshot: 'snapshot' } })
      .mockResolvedValueOnce({ ok: true, data: { path: '.webAgent-archive/index/runs.jsonl', lines: [{ lineNumber: 2, content: record('r2', 'delegated') }, { lineNumber: 1, content: record('r1', 'running') }], hasMore: false, snapshot: 'snapshot' } })
    const user = userEvent.setup()

    renderPanel('/workspace/paging')
    await screen.findByRole('button', { name: /r1.*paging.*done/ })
    await user.click(screen.getByRole('button', { name: '加载更多历史 run' }))
    expect(await screen.findByRole('button', { name: /r2.*paging.*delegated/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /r1.*paging.*done/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '加载更多历史 run' })).not.toBeInTheDocument()
    expect(vi.mocked(readWorkspaceRunIndexPage).mock.calls[1][0]).toMatchObject({ cursor: 'snapshot:2', workspaceRoot: '/workspace/paging' })
  })

  it('解释 candidate 评分，并经人工确认仅生成尚未执行的治理 CLI', async () => {
    const record = JSON.stringify({
      type: 'skill', skillId: 'sk_review', kind: 'core', globalPath: '.webAgent-archive/skills/sk_review.md',
      contentHash: 'h64:1234567890abcd', promotion: 'candidate', inheritSkillIds: [], sourceTranscriptChars: 1_000,
      createdAt: '2026-07-21T00:00:00.000Z', summary: '可复用的归档校验策略',
    })
    vi.mocked(readWorkspaceFile).mockImplementation(async (input) => {
      const content = input.path.endsWith('skills.jsonl') ? record : '---\nskill_id: "sk_review"\npromotion: "candidate"\n---\n\nbody\n'
      return { ok: true, data: { path: input.path, content, bytes: content.length, truncated: false } }
    })
    const user = userEvent.setup()

    renderPanel('/workspace/review')
    await user.click(await screen.findByRole('button', { name: /sk_review.*core.*29/ }))
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
