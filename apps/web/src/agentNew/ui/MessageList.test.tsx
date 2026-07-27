import { afterEach, describe, it, expect, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { createStore } from '@einfach/core'
import { renderWithStore } from '../../test/renderWithStore'
import { checkpointsAtom, itemsAtom, runAtom } from '@web-agent/core/state/sessionAtoms'
import {
  browserCardsAtom,
  runtimeTranscriptEventsAtom,
  type BrowserCard,
} from '@web-agent/core/state/transientAtoms'
import type { ConversationItem } from '@web-agent/core/state/core.type'
import { executionGraphAtom } from '@web-agent/core/execution/graph'
import { revertTurnToDraft } from '@web-agent/core/runtime/commands'
import { MessageList } from './MessageList'
import {
  MESSAGE_WINDOW_SIZE,
  MESSAGE_WINDOW_STEP,
  messageWindowAtom,
} from './messageWindowModel'

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

  it('渲染右侧 user、assistant markdown，并把 tool result 收进默认展开的思考过程', () => {
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
    const strong = screen.getByText('回复')
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

  it('tool result 通过 tool_call_id 关联工具名并显示结果摘要', () => {
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
              function: { name: 'skill_read', arguments: '{"name":"web-chat-agent"}' },
            },
          ],
        },
      },
      { id: 't1', createdAt: 1, item: { role: 'tool', tool_call_id: 'tc1', content: '{"ok":true}' } },
    ]
    store.setter(itemsAtom, items)

    renderWithStore(<MessageList />, { store })

    expectThinkingProcessExpanded()
    const execution = screen.getByText('工具 skill_read').closest('.agentnew-debug-entry')
    expect(execution).not.toBeNull()
    expect(execution).toHaveTextContent('调用：name=web-chat-agent')
    expect(execution).toHaveTextContent('结果：ok=true')
    expect(execution).toHaveTextContent('调用与结果')
    expect(document.querySelectorAll('.agentnew-debug-entry--tool-execution')).toHaveLength(1)
    expect(screen.getByText('ok=true')).toBeInTheDocument()
  })

  it('把子 agent 完整轨迹放在触发它的 delegate_agent 调用下，并默认折叠', () => {
    const store = createStore()
    store.setter(itemsAtom, [{
      id: 'delegate-message',
      createdAt: 1,
      item: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'delegate-1',
          type: 'function',
          function: {
            name: 'delegate_agent',
            arguments: '{"children":[{"objective":"检查执行图"}]}',
          },
        }],
      },
    }])
    store.setter(executionGraphAtom, {
      version: 1,
      order: ['run:root-01'],
      nodes: {
        'run:root-01': {
          id: 'run:root-01',
          graphId: 'run',
          sessionId: 'session',
          runId: 'run',
          dependsOn: [],
          type: 'agent',
          status: 'succeeded',
          label: '检查执行图',
          attempt: 1,
          generation: 1,
          effectKeys: [],
          createdAt: 1,
          updatedAt: 2,
          result: { path: 'root-01', delegationCallId: 'delegate-1' },
          trace: [
            {
              timestamp: '2026-07-23T05:00:00.000Z',
              turn: 1,
              item: {
                role: 'assistant',
                content: null,
                reasoning_content: '先确认节点状态。',
                tool_calls: [{
                  id: 'read-1',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{"path":"graph.ts"}' },
                }],
              },
            },
            {
              timestamp: '2026-07-23T05:00:01.000Z',
              turn: 1,
              item: {
                role: 'tool',
                tool_call_id: 'read-1',
                content: '{"ok":true}',
              },
            },
          ],
        },
      },
    })

    renderWithStore(<MessageList />, { store })
    expectThinkingProcessExpanded()
    const delegateEntry = screen.getByText('调用工具 delegate_agent')
      .closest('.agentnew-debug-entry')
    const inline = delegateEntry?.parentElement?.querySelector('details.agentnew-subagent-inline')
    expect(inline).not.toBeNull()
    expect(inline).not.toHaveAttribute('open')
    expect(inline).toHaveTextContent('子 agent')
    expect(inline).toHaveTextContent('检查执行图')
    expect(inline).toHaveTextContent('先确认节点状态。')
    expect(inline).toHaveTextContent('read_file')
    expect(inline).toHaveTextContent('"ok": true')
  })

  it('失败和警告的 tool result 使用对应文案与状态颜色类', () => {
    const store = createStore()
    const items: ConversationItem[] = [
      {
        id: 'a-tools',
        createdAt: 0,
        item: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'tc-error',
              type: 'function',
              function: { name: 'save_file', arguments: '{}' },
            },
            {
              id: 'tc-warning',
              type: 'function',
              function: { name: 'rg_search', arguments: '{}' },
            },
          ],
        },
      },
      {
        id: 't-error',
        createdAt: 1,
        item: {
          role: 'tool',
          tool_call_id: 'tc-error',
          content: '{"error":"permission denied"}',
        },
      },
      {
        id: 't-warning',
        createdAt: 2,
        item: {
          role: 'tool',
          tool_call_id: 'tc-warning',
          content: '{"data":{"ok":true},"warnings":["limit 已钳位"]}',
        },
      },
    ]
    store.setter(itemsAtom, items)

    renderWithStore(<MessageList />, { store })

    expectThinkingProcessExpanded()
    const errorEntry = screen.getByText('工具失败 save_file').closest('.agentnew-debug-entry')
    expect(errorEntry).toHaveClass('agentnew-debug-entry--error')
    expect(errorEntry).toHaveTextContent('错误')
    expect(errorEntry).toHaveTextContent('error=permission denied')

    const warningEntry = screen.getByText('工具警告 rg_search').closest('.agentnew-debug-entry')
    expect(warningEntry).toHaveClass('agentnew-debug-entry--warning')
    expect(warningEntry).toHaveTextContent('警告')
    expect(warningEntry).toHaveTextContent('warning=limit 已钳位')

    const executionGroup = errorEntry?.closest('.agentnew-tool-execution-group')
    expect(executionGroup).toHaveClass('is-multiple')
    expect(executionGroup?.querySelectorAll('.agentnew-tool-execution-item')).toHaveLength(2)
    expect(warningEntry?.closest('.agentnew-tool-execution-group')).toBe(executionGroup)
  })

  it('值为 false 的 error / warning 字段不误判为失败或警告', () => {
    const store = createStore()
    store.setter(itemsAtom, [
      {
        id: 't-success',
        createdAt: 0,
        item: {
          role: 'tool',
          tool_call_id: 'tc-success',
          content: '{"ok":true,"error":false,"warning":false}',
        },
      },
    ])

    const { container } = renderWithStore(<MessageList />, { store })

    expectThinkingProcessExpanded()
    expect(screen.getByText('工具 tc-success')).toBeInTheDocument()
    expect(container.querySelector('.agentnew-debug-entry--error')).toBeNull()
    expect(container.querySelector('.agentnew-debug-entry--warning')).toBeNull()
  })

  it('runtime 注入事件显示在 transcript 中，但不依赖 system ConversationItem', () => {
    const store = createStore()
    store.setter(runtimeTranscriptEventsAtom, [
      {
        id: 'rt1',
        createdAt: 0,
        kind: 'system_injection',
        title: '注入 system',
        summary: '已加载 skills：web-chat-agent',
        detail: '完整 system prompt',
      },
    ])

    renderWithStore(<MessageList />, { store })

    expectThinkingProcessExpanded()
    expect(screen.getByText('注入')).toBeInTheDocument()
    expect(screen.getByText('注入 system')).toBeInTheDocument()
    expect(screen.getByText('已加载 skills：web-chat-agent')).toBeInTheDocument()
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

  it('browser 卡片与消息按 createdAt 合并排序渲染', () => {
    const store = createStore()
    store.setter(itemsAtom, [
      { id: 'u1', createdAt: 1, item: { role: 'user', content: '问' } },
      { id: 'a1', createdAt: 3, item: { role: 'assistant', content: '答' } },
    ])
    const cards: BrowserCard[] = [{ id: 'c1', createdAt: 2, title: '卡A' }]
    store.setter(browserCardsAtom, cards)

    renderWithStore(<MessageList />, { store })

    expect(screen.getByText('问').closest('.agentnew-msg')).toHaveClass('agentnew-msg--user')
    const card = screen.getByText('卡A')
    const assistant = screen.getByText('答')

    // DOM 顺序：user(1) → 卡A(2) → assistant(3)。
    // compareDocumentPosition(x) 含 FOLLOWING 位 ⇒ x 在参考节点之后
    expect(card.compareDocumentPosition(assistant) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('只有 user item 时也渲染右侧消息，不显示空占位', () => {
    const store = createStore()
    store.setter(itemsAtom, [
      { id: 'b-item', createdAt: 5, item: { role: 'user', content: '条目B' } },
    ])

    const { container } = renderWithStore(<MessageList />, { store })

    expect(container.querySelector('.agentnew-message-empty')).toBeNull()
    expect(screen.getByText('条目B').closest('.agentnew-msg')).toHaveClass('agentnew-msg--user')
  })

  it('长对话只挂载最新滑动窗口，不创建总高度占位', () => {
    const store = createStore()
    store.setter(itemsAtom, Array.from({ length: 500 }, (_, index): ConversationItem => ({
      id: `message-${index}`,
      createdAt: index,
      item: { role: 'assistant', content: `第 ${index + 1} 条消息` },
    })))

    const { container } = renderWithStore(<MessageList />, { store })

    const mountedRows = container.querySelectorAll('.agentnew-window-row')
    expect(container.querySelector('.agentnew-virtual-sizer')).toBeNull()
    expect(mountedRows).toHaveLength(80)
    expect(screen.getByText('第 500 条消息')).toBeInTheDocument()
    expect(screen.queryByText('第 1 条消息')).toBeNull()
  })

  it('滚到当前窗口顶部时向历史方向换窗，并保持固定挂载数量', () => {
    const store = createStore()
    store.setter(itemsAtom, Array.from({ length: 500 }, (_, index): ConversationItem => ({
      id: `message-${index}`,
      createdAt: index,
      item: { role: 'assistant', content: `第 ${index + 1} 条消息` },
    })))

    const { container } = renderWithStore(<MessageList />, { store })
    const list = container.querySelector<HTMLElement>('.agentnew-message-list')
    expect(list).not.toBeNull()
    Object.defineProperties(list!, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 4_000 },
    })
    list!.scrollTop = 0
    fireEvent.scroll(list!)

    expect(store.getter(messageWindowAtom)).toMatchObject({
      start: 500 - MESSAGE_WINDOW_SIZE - MESSAGE_WINDOW_STEP,
      end: 500 - MESSAGE_WINDOW_STEP,
      direction: 'backward',
    })
    expect(container.querySelectorAll('.agentnew-window-row')).toHaveLength(
      MESSAGE_WINDOW_SIZE,
    )
    expect(screen.getByText('第 397 条消息')).toBeInTheDocument()
    expect(screen.queryByText('第 500 条消息')).toBeNull()
  })

  // 轮次 3 · TM1-4：GFM 表格 / 链接 target=_blank / raw HTML 转义安全回归。
  it('TM3：assistant 内容含 GFM 表格语法 → 渲染出 <table>（外包 .agentnew-md-table-wrap）', () => {
    const store = createStore()
    const items: ConversationItem[] = [
      {
        id: 'a-table',
        createdAt: 0,
        item: { role: 'assistant', content: '| a | b |\n| - | - |\n| 1 | 2 |' },
      },
    ]
    store.setter(itemsAtom, items)

    const { container } = renderWithStore(<MessageList />, { store })

    const table = screen.getByRole('table')
    expect(table).toBeInTheDocument()
    // 表格被包在 .agentnew-md-table-wrap 里（overflow-x:auto 防撑破气泡）
    expect(container.querySelector('.agentnew-md-table-wrap table')).toBe(table)
    expect(screen.getByText('a')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('TM3：assistant 内容含链接 → <a> 带 target=_blank 且 rel 含 noopener', () => {
    const store = createStore()
    const items: ConversationItem[] = [
      {
        id: 'a-link',
        createdAt: 0,
        item: { role: 'assistant', content: '[点击](https://example.com)' },
      },
    ]
    store.setter(itemsAtom, items)

    renderWithStore(<MessageList />, { store })

    const link = screen.getByRole('link', { name: '点击' })
    expect(link).toHaveAttribute('href', 'https://example.com')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('安全回归：assistant 内容含 <script>/<img onerror> → 不渲染为真实元素，以转义文本呈现', () => {
    const store = createStore()
    const items: ConversationItem[] = [
      {
        id: 'a-xss',
        createdAt: 0,
        item: {
          role: 'assistant',
          content: '注入测试：<script>alert(1)</script> 与 <img src=x onerror=alert(1)>',
        },
      },
    ]
    store.setter(itemsAtom, items)

    const { container } = renderWithStore(<MessageList />, { store })

    // 不存在真实的 script / img 元素
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    // 原始标签以转义文本形式可见
    expect(container.textContent).toContain('<script>alert(1)</script>')
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
  })
})
