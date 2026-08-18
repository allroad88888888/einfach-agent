import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { createStore } from '@einfach/core'
import { renderWithStore } from '../../test/renderWithStore'
import { itemsAtom, runtimeTranscriptEventsAtom, type ConversationItem } from '@web-agent/core'
import { MessageList } from './MessageList'

function expectThinkingProcessExpanded() {
  const toggle = screen.getByRole('button', { name: /思考过程/ })
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
}

/** Covers tool results and injected runtime events in MessageList transcripts. */
describe('MessageList tool results', () => {
  it('links a tool result to its call and displays a result summary', () => {
    const store = createStore()
    const items: ConversationItem[] = [
      {
        id: 'a-tool',
        createdAt: 0,
        item: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'skill_read', arguments: '{"name":"web-chat-agent"}' } }],
        },
      },
      { id: 't1', createdAt: 1, item: { role: 'tool', tool_call_id: 'tc1', content: '{"ok":true}' } },
    ]
    store.setter(itemsAtom, items)

    renderWithStore(<MessageList />, { agentStore: store })

    expectThinkingProcessExpanded()
    const execution = screen.getByText('工具 skill_read').closest('.agentnew-debug-entry')
    expect(execution).not.toBeNull()
    expect(execution).toHaveTextContent('调用：name=web-chat-agent')
    expect(execution).toHaveTextContent('结果：ok=true')
    expect(execution).toHaveTextContent('调用与结果')
    expect(document.querySelectorAll('.agentnew-debug-entry--tool-execution')).toHaveLength(1)
    expect(screen.getByText('ok=true')).toBeInTheDocument()
  })

  it('uses failure and warning labels and classes for tool results', () => {
    const store = createStore()
    const items: ConversationItem[] = [
      {
        id: 'a-tools', createdAt: 0,
        item: {
          role: 'assistant', content: null,
          tool_calls: [
            { id: 'tc-error', type: 'function', function: { name: 'save_file', arguments: '{}' } },
            { id: 'tc-warning', type: 'function', function: { name: 'rg_search', arguments: '{}' } },
          ],
        },
      },
      { id: 't-error', createdAt: 1, item: { role: 'tool', tool_call_id: 'tc-error', content: '{"error":"permission denied"}' } },
      { id: 't-warning', createdAt: 2, item: { role: 'tool', tool_call_id: 'tc-warning', content: '{"data":{"ok":true},"warnings":["limit 已钳位"]}' } },
    ]
    store.setter(itemsAtom, items)

    renderWithStore(<MessageList />, { agentStore: store })

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

  it('does not treat false error or warning fields as failed tool results', () => {
    const store = createStore()
    store.setter(itemsAtom, [{
      id: 't-success', createdAt: 0,
      item: { role: 'tool', tool_call_id: 'tc-success', content: '{"ok":true,"error":false,"warning":false}' },
    }])

    const { container } = renderWithStore(<MessageList />, { agentStore: store })

    expectThinkingProcessExpanded()
    expect(screen.getByText('工具 tc-success')).toBeInTheDocument()
    expect(container.querySelector('.agentnew-debug-entry--error')).toBeNull()
    expect(container.querySelector('.agentnew-debug-entry--warning')).toBeNull()
  })

  it('renders injected runtime events without a system conversation item', () => {
    const store = createStore()
    store.setter(runtimeTranscriptEventsAtom, [{
      id: 'rt1', createdAt: 0, kind: 'system_injection', title: '注入 system',
      summary: '已加载 skills：web-chat-agent', detail: '完整 system prompt',
    }])

    renderWithStore(<MessageList />, { agentStore: store })

    expectThinkingProcessExpanded()
    expect(screen.getByText('注入')).toBeInTheDocument()
    expect(screen.getByText('注入 system')).toBeInTheDocument()
    expect(screen.getByText('已加载 skills：web-chat-agent')).toBeInTheDocument()
  })
})
