import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { createStore } from '@einfach/core'
import { renderWithStore } from '../../test/renderWithStore'
import { itemsAtom, executionGraphAtom } from '@web-agent/core'
import { MessageList } from './MessageList'

function expectThinkingProcessExpanded() {
  const toggle = screen.getByRole('button', { name: /思考过程/ })
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
}

/** Covers the nested execution trace attached to a delegate_agent call. */
describe('MessageList subagent trace', () => {
  it('places the complete child trace under its collapsed delegate_agent call', () => {
    const store = createStore()
    store.setter(itemsAtom, [{
      id: 'delegate-message', createdAt: 1,
      item: {
        role: 'assistant', content: null,
        tool_calls: [{
          id: 'delegate-1', type: 'function',
          function: { name: 'delegate_agent', arguments: '{"children":[{"objective":"检查执行图"}]}' },
        }],
      },
    }])
    store.setter(executionGraphAtom, {
      version: 1,
      order: ['run:root-01'],
      nodes: {
        'run:root-01': {
          id: 'run:root-01', graphId: 'run', sessionId: 'session', runId: 'run', dependsOn: [],
          type: 'agent', status: 'succeeded', label: '检查执行图', attempt: 1, generation: 1,
          effectKeys: [], createdAt: 1, updatedAt: 2,
          result: { path: 'root-01', delegationCallId: 'delegate-1' },
          trace: [
            {
              timestamp: '2026-07-23T05:00:00.000Z', turn: 1,
              item: {
                role: 'assistant', content: null, reasoning_content: '先确认节点状态。',
                tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"graph.ts"}' } }],
              },
            },
            {
              timestamp: '2026-07-23T05:00:01.000Z', turn: 1,
              item: { role: 'tool', tool_call_id: 'read-1', content: '{"ok":true}' },
            },
          ],
        },
      },
    })

    renderWithStore(<MessageList />, { store })

    expectThinkingProcessExpanded()
    const delegateEntry = screen.getByText('调用工具 delegate_agent').closest('.agentnew-debug-entry')
    const inline = delegateEntry?.parentElement?.querySelector('details.agentnew-subagent-inline')
    expect(inline).not.toBeNull()
    expect(inline).not.toHaveAttribute('open')
    expect(inline).toHaveTextContent('子 agent')
    expect(inline).toHaveTextContent('检查执行图')
    expect(inline).toHaveTextContent('先确认节点状态。')
    expect(inline).toHaveTextContent('read_file')
    expect(inline).toHaveTextContent('"ok": true')
  })
})
