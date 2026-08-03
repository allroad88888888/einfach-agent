import { describe, expect, it } from 'vitest'
import {
  isTimelineThinkingItem,
  projectPlanStageTimelineItems,
  projectTimelineItems,
} from './timelineProjection'
import type { ConversationItem } from '../state/core.type'
import type { BrowserCard, RuntimeTranscriptEvent } from '../state/transientAtoms'

function toolCall(id: string, name: string) {
  return { id, type: 'function' as const, function: { name, arguments: '{}' } }
}

describe('timelineProjection', () => {
  it('projects conversation records, runtime events and browser cards into stable chronological items', () => {
    const items: ConversationItem[] = [
      { id: 'user', createdAt: 2, item: { role: 'user', content: '问题' } },
      {
        id: 'assistant',
        createdAt: 4,
        item: {
          role: 'assistant',
          reasoning_content: '先分析',
          content: '执行说明',
          tool_calls: [toolCall('call-1', 'read_file')],
        },
      },
      { id: 'result', createdAt: 5, item: { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' } },
      { id: 'system', createdAt: 6, item: { role: 'system', content: '不可见' } },
      { id: 'orphan', createdAt: 7, item: { role: 'tool', tool_call_id: 'missing', content: '仍须显示' } },
    ]
    const runtimeEvents: RuntimeTranscriptEvent[] = [
      { id: 'runtime', createdAt: 3, kind: 'tool_manifest', title: '工具清单' },
    ]
    const browserCards: BrowserCard[] = [{ id: 'card', createdAt: 1, title: '卡片' }]

    const projection = projectTimelineItems({ conversationItems: items, runtimeEvents, browserCards })

    expect(projection.map((item) => `${item.kind}:${item.id}`)).toEqual([
      'card:card:card',
      'message:user:message',
      'runtime-event:runtime:runtime',
      'reasoning:assistant:reasoning',
      'thinking-message:assistant:message',
      'tool-execution-group:assistant:tool-execution-group',
      'tool-execution-group:orphan:tool-execution-group',
    ])
    const paired = projection.find((item) => item.id === 'assistant:tool-execution-group')
    expect(paired).toMatchObject({
      kind: 'tool-execution-group',
      executions: [{ call: { id: 'call-1' }, result: { tool_call_id: 'call-1', content: '{"ok":true}' } }],
    })
    const orphan = projection.find((item) => item.id === 'orphan:tool-execution-group')
    expect(orphan).toMatchObject({
      kind: 'tool-execution-group',
      executions: [{ toolName: 'missing', result: { content: '仍须显示' } }],
    })
  })

  it('does not mutate its inputs and keeps same-timestamp ordering deterministic', () => {
    const items: ConversationItem[] = [
      { id: 'first', createdAt: 10, item: { role: 'user', content: 'first' } },
      { id: 'second', createdAt: 10, item: { role: 'user', content: 'second' } },
    ]
    const originalIds = items.map((item) => item.id)
    const projection = projectTimelineItems({
      conversationItems: items,
      runtimeEvents: [{ id: 'event', createdAt: 10, kind: 'system_injection', title: '事件' }],
      browserCards: [{ id: 'card', createdAt: 10, title: '卡片' }],
    })

    expect(items.map((item) => item.id)).toEqual(originalIds)
    expect(projection.map((item) => item.sortKey)).toEqual([
      'card:card',
      'item:000000:first:message',
      'item:000001:second:message',
      'runtime:000000:event',
    ])
  })

  it('projects plan-stage assistant text as thinking and excludes non-thinking stage records', () => {
    const entries = projectPlanStageTimelineItems([
      { id: 'user', createdAt: 0, planStageId: 'stage-1', item: { role: 'user', content: '开始' } },
      {
        id: 'assistant',
        createdAt: 1,
        planStageId: 'stage-1',
        item: {
          role: 'assistant',
          reasoning_content: '分析',
          content: '执行中',
          tool_calls: [toolCall('call-1', 'read_file')],
        },
      },
      { id: 'result', createdAt: 2, planStageId: 'stage-1', item: { role: 'tool', tool_call_id: 'call-1', content: '完成' } },
      { id: 'other', createdAt: 3, planStageId: 'stage-2', item: { role: 'assistant', content: '另一阶段' } },
    ])

    expect(entries.get('stage-1')?.map((item) => item.kind)).toEqual([
      'reasoning',
      'thinking-message',
      'tool-execution-group',
    ])
    expect(entries.get('stage-2')?.map((item) => item.kind)).toEqual(['thinking-message'])
    const stageItem = entries.get('stage-1')?.[0]
    expect(stageItem && isTimelineThinkingItem(stageItem)).toBe(true)
  })
})
