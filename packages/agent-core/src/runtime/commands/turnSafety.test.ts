import { describe, expect, it } from 'vitest'
import type { ConversationItem } from '../../state/core.type'
import { currentTurnHasSideEffects } from './turnSafety'

function assistantToolCall(name: string): ConversationItem {
  return {
    id: name,
    createdAt: 1,
    item: {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: `call-${name}`, type: 'function', function: { name, arguments: '{}' } }],
    },
  }
}

describe('currentTurnHasSideEffects', () => {
  it('recognizes dangerous tools and run_task while ignoring safe calls', () => {
    expect(currentTurnHasSideEffects([assistantToolCall('read_file')])).toBe(false)
    expect(currentTurnHasSideEffects([assistantToolCall('run_task')])).toBe(true)
    expect(currentTurnHasSideEffects([assistantToolCall('write_file')])).toBe(true)
  })
})
