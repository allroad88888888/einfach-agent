import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ConversationItem } from '@einfach-agent/core'
import { ConversationTimeline } from './ConversationTimeline'

describe('ConversationTimeline progressive disclosure', () => {
  it('folds consecutive runtime events while keeping messages visible', () => {
    const items: ConversationItem[] = [{ id: 'user', createdAt: 1, item: { role: 'user', content: '开始' } }]
    const runtimeEvents = [
      { id: 'one', createdAt: 2, kind: 'system_injection', title: '系统上下文' },
      { id: 'two', createdAt: 3, kind: 'tool_manifest', title: '工具清单', summary: '19 项工具' },
    ] as const
    render(<ConversationTimeline items={items} runtimeEvents={runtimeEvents} browserCards={[]} />)

    expect(screen.getByText('开始')).toBeVisible()
    expect(screen.getByText('运行详情')).toBeVisible()
    expect(screen.getByText('系统上下文')).not.toBeVisible()
    fireEvent.click(screen.getByText('运行详情'))
    expect(screen.getByText('系统上下文')).toBeVisible()
    expect(screen.getByText('19 项工具')).toBeVisible()
  })

  it('keeps tool name and status visible but folds raw arguments and results', () => {
    const items: ConversationItem[] = [
      { id: 'assistant', createdAt: 1, item: { role: 'assistant', content: '', tool_calls: [{ id: 'call', type: 'function', function: { name: 'read_page', arguments: '{"selector":"main"}' } }] } },
      { id: 'result', createdAt: 2, item: { role: 'tool', tool_call_id: 'call', content: '{"ok":true}' } },
    ]
    render(<ConversationTimeline items={items} runtimeEvents={[]} browserCards={[]} />)

    expect(screen.getByText('read_page')).toBeVisible()
    expect(screen.getByText('已完成')).toBeVisible()
    expect(screen.getByText('{"selector":"main"}')).not.toBeVisible()
    fireEvent.click(screen.getByText('参数与结果'))
    expect(screen.getByText('{"selector":"main"}')).toBeVisible()
    expect(screen.getByText('{"ok":true}')).toBeVisible()
  })
})
