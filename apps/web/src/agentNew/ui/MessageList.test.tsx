import { afterEach, describe, it, expect, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { createStore } from '@einfach/core'
import { renderWithStore } from '../../test/renderWithStore'
import { checkpointsAtom, itemsAtom, runAtom } from '@web-agent/core/state/sessionAtoms'
import type { ConversationItem } from '@web-agent/core/state/core.type'
import { revertTurnToDraft } from '@web-agent/core/runtime/commands'
import { MessageList } from './MessageList'

vi.mock('@web-agent/core/runtime/commands', () => ({ revertTurnToDraft: vi.fn() }))

function expectThinkingProcessExpanded() {
  const toggle = screen.getByRole('button', { name: /思考过程/ })
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  return toggle
}

// P-U3 / P8-g MessageList：读会话 store 的 itemsAtom + browserCardsAtom，
// 渲染 user/assistant 文本，并把 assistant.reasoning_content、tool_calls、tool result、
// runtime 注入事件收进思考过程；
// system ConversationItem 不渲染；browser 卡片与 items 按 createdAt 合并排序；空列表给占位。

describe('MessageList', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('在已形成 checkpoint 的用户消息下显示回退按钮，并回退到对应轮次', () => {
    const store = createStore()
    const firstTurn: ConversationItem[] = [
      { id: 'u1', createdAt: 0, item: { role: 'user', content: '第一问' } },
      { id: 'a1', createdAt: 1, item: { role: 'assistant', content: '第一答' } },
    ]
    const secondTurn: ConversationItem[] = [
      ...firstTurn,
      { id: 'u2', createdAt: 2, item: { role: 'user', content: '第二问' } },
      { id: 'a2', createdAt: 3, item: { role: 'assistant', content: '第二答' } },
    ]
    store.setter(itemsAtom, secondTurn)
    store.setter(checkpointsAtom, [
      { turnIndex: 0, label: '第一问', createdAt: 1, items: firstTurn },
      { turnIndex: 1, label: '第二问', createdAt: 3, items: secondTurn },
    ])

    renderWithStore(<MessageList />, { store })

    const firstRevert = screen.getByRole('button', { name: '回退到第 1 轮之前' })
    const secondRevert = screen.getByRole('button', { name: '回退到第 2 轮之前' })
    expect(firstRevert).toBeInTheDocument()
    expect(secondRevert).toBeInTheDocument()
    expect(screen.getAllByText('回退')).toHaveLength(2)

    fireEvent.click(firstRevert)
    expect(revertTurnToDraft).toHaveBeenCalledTimes(1)
    expect(revertTurnToDraft).toHaveBeenCalledWith(0)
  })

  it('尚未形成 checkpoint 的用户消息不显示无效回退按钮', () => {
    const store = createStore()
    store.setter(itemsAtom, [
      { id: 'u-pending', createdAt: 0, item: { role: 'user', content: '处理中' } },
    ])

    renderWithStore(<MessageList />, { store })

    expect(screen.queryByRole('button', { name: /回退到第/ })).toBeNull()
  })

  it('渲染右侧 user、assistant markdown，并把 tool result 收进默认展开的思考过程', async () => {
    const store = createStore()
    const items: ConversationItem[] = [
      { id: 'u1', createdAt: 0, item: { role: 'user', content: '你好' } },
      { id: 'a1', createdAt: 1, item: { role: 'assistant', content: '**回复**' } },
      { id: 's1', createdAt: 2, item: { role: 'system', content: '系统' } },
      { id: 't1', createdAt: 3, item: { role: 'tool', tool_call_id: 'x', content: '工具' } },
    ]
    store.setter(itemsAtom, items)

    renderWithStore(<MessageList />, { store })

    const user = screen.getByText('你好').closest('.agentnew-msg')
    expect(user).toHaveClass('agentnew-msg--user')
    // assistant 的 markdown 被渲染：**回复** → <strong>回复</strong>
    const strong = await screen.findByText('回复')
    expect(strong).toBeInTheDocument()
    expect(strong.tagName).toBe('STRONG')
    // system ConversationItem 不渲染；思考过程默认展开并直接挂载 tool result。
    expect(screen.queryByText('系统')).toBeNull()
    const toggle = expectThinkingProcessExpanded()
    expect(screen.getByText('工具 x')).toBeInTheDocument()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('工具 x')).toBeNull()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('工具 x')).toBeInTheDocument()
  })

  it('空列表渲染占位', () => {
    const store = createStore()
    store.setter(itemsAtom, [])

    const { container } = renderWithStore(<MessageList />, { store })

    expect(container.querySelector('.agentnew-message-empty')).not.toBeNull()
    expect(screen.getByText('开始对话吧')).toBeInTheDocument()
  })

  it('P3：content 为 null / 纯空白的 assistant 不渲染空气泡，有实质文本才渲染', () => {
    const store = createStore()
    const items: ConversationItem[] = [
      // 纯工具调用轮：content=null，不该冒空气泡
      { id: 'a-null', createdAt: 0, item: { role: 'assistant', content: null } },
      // 全空白也视为空，不渲染
      { id: 'a-blank', createdAt: 1, item: { role: 'assistant', content: '   \n ' } },
      // 有实质文本，正常渲染
      { id: 'a-text', createdAt: 2, item: { role: 'assistant', content: '有内容' } },
    ]
    store.setter(itemsAtom, items)

    const { container } = renderWithStore(<MessageList />, { store })

    // 只剩一个 assistant 气泡（有文本那个）
    expect(container.querySelectorAll('.agentnew-msg--assistant')).toHaveLength(1)
    expect(screen.getByText('有内容')).toBeInTheDocument()
  })

  it('纯工具调用 assistant 不冒空文本气泡，但显示 tool_calls', () => {
    const store = createStore()
    const items: ConversationItem[] = [
      {
        id: 'a-tool',
        createdAt: 0,
        item: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'tc1',
              type: 'function',
              function: { name: 'skill_search', arguments: '{"query":"stream output"}' },
            },
          ],
        },
      },
    ]
    store.setter(itemsAtom, items)

    const { container } = renderWithStore(<MessageList />, { store })

    expect(container.querySelectorAll('.agentnew-msg--assistant')).toHaveLength(0)
    expectThinkingProcessExpanded()
    expect(screen.getByText('调用工具 skill_search')).toBeInTheDocument()
    expect(screen.getByText('query=stream output')).toBeInTheDocument()
  })

  it('reasoning_content 显示在默认展开的思考过程，最终 content 仍作为 assistant 气泡显示', () => {
    const store = createStore()
    store.setter(itemsAtom, [
      {
        id: 'a-reasoning',
        createdAt: 0,
        item: {
          role: 'assistant',
          reasoning_content: '先分析用户意图，再组织答案。',
          content: '最终答案',
        },
      },
    ])

    const { container } = renderWithStore(<MessageList />, { store })

    expectThinkingProcessExpanded()
    expect(screen.getByText('模型思考')).toBeInTheDocument()
    expect(screen.getByText('先分析用户意图，再组织答案。')).toBeInTheDocument()
    expect(screen.getByText('最终答案').closest('.agentnew-msg--assistant')).not.toBeNull()
    expect(container.querySelectorAll('.agentnew-msg--assistant')).toHaveLength(1)
  })

  it('reasoning-only 的工具轮实时显示思考，不产生空 assistant 气泡', () => {
    const store = createStore()
    store.setter(itemsAtom, [
      {
        id: 'a-reasoning-tool',
        createdAt: 0,
        pending: true,
        item: {
          role: 'assistant',
          reasoning_content: '需要先读取工具定义。',
          content: '',
          tool_calls: [
            {
              id: 'tc-reasoning',
              type: 'function',
              function: { name: 'request_tool_schema', arguments: '{"toolName":"skill_read"}' },
            },
          ],
        },
      },
    ])

    const { container } = renderWithStore(<MessageList />, { store })

    expectThinkingProcessExpanded()
    expect(screen.getByText('需要先读取工具定义。')).toBeInTheDocument()
    expect(screen.getByText('调用工具 request_tool_schema')).toBeInTheDocument()
    expect(container.querySelectorAll('.agentnew-msg--assistant')).toHaveLength(0)
  })

  it('pending assistant 显示流式生成光标；完成态不显示', () => {
    const store = createStore()
    const items: ConversationItem[] = [
      { id: 'a-streaming', createdAt: 0, pending: true, item: { role: 'assistant', content: '生成中' } },
      { id: 'a-done', createdAt: 1, pending: false, item: { role: 'assistant', content: '已完成' } },
    ]
    store.setter(itemsAtom, items)

    const { container } = renderWithStore(<MessageList />, { store })

    const bubbles = container.querySelectorAll('.agentnew-msg--assistant')
    expect(bubbles).toHaveLength(2)
    expect(bubbles[0].classList.contains('agentnew-msg--streaming')).toBe(true)
    expect(bubbles[0].querySelector('.agentnew-stream-caret')).not.toBeNull()
    expect(bubbles[1].classList.contains('agentnew-msg--streaming')).toBe(false)
    expect(bubbles[1].querySelector('.agentnew-stream-caret')).toBeNull()
  })

  it('运行中显示 Working for，并按当前轮用户消息起点计算耗时', () => {
    const store = createStore()
    const startedAt = Date.now() - 220_500
    store.setter(itemsAtom, [
      { id: 'u-working', createdAt: startedAt, item: { role: 'user', content: '开始工作' } },
      { id: 'a-working', createdAt: startedAt + 1_000, pending: true, item: { role: 'assistant', content: '处理中' } },
    ])
    store.setter(runAtom, {
      runId: 'run-working',
      turnId: 'u-working',
      status: 'running',
      startedAt,
    })

    renderWithStore(<MessageList />, { store })

    const status = screen.getByLabelText('对话正在进行，已用时 3m 40s')
    expect(status).toHaveTextContent('Working for 3m 40s')
  })

  it('对话完成后显示 Brewed for，并固定为 run 的真实完成耗时', () => {
    const store = createStore()
    store.setter(itemsAtom, [
      { id: 'u-done', createdAt: 1_000, item: { role: 'user', content: '完成任务' } },
      { id: 'a-done', createdAt: 61_000, item: { role: 'assistant', content: '已经完成' } },
    ])
    store.setter(runAtom, {
      runId: 'run-done',
      turnId: 'u-done',
      status: 'done',
      startedAt: 1_000,
      finishedAt: 221_000,
    })

    renderWithStore(<MessageList />, { store })

    const status = screen.getByLabelText('对话已结束，用时 3m 40s')
    expect(status).toHaveTextContent('Brewed for 3m 40s')
  })

})
