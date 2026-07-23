import { describe, it, expect } from 'vitest'
import type { Checkpoint, CheckpointMeta } from './checkpoint.type'

// 纯类型文件无运行时逻辑：靠「构造合法字面量 + 越界字段类型断言」制造红→绿。
describe('checkpoint.type', () => {
  it('可构造合法的 Checkpoint（含最小 ConversationItem）', () => {
    const cp: Checkpoint = {
      turnIndex: 0,
      label: 'first turn',
      createdAt: 0,
      items: [
        {
          id: 'i1',
          createdAt: 0,
          item: { role: 'user', content: 'hi' },
        },
      ],
    }

    expect(cp.items).toHaveLength(1)
    expect(cp.turnIndex).toBe(0)
  })

  it('CheckpointMeta 是去 items 的轻量版', () => {
    const meta: CheckpointMeta = { turnIndex: 0, label: 'x', createdAt: 0 }

    expect(meta).not.toHaveProperty('items')

    // @ts-expect-error CheckpointMeta 不含 items，加上应类型报错
    const bad: CheckpointMeta = { turnIndex: 0, label: 'x', createdAt: 0, items: [] }
    expect(bad).toBeDefined()
  })
})
