import { describe, expect, it } from 'vitest'
import { readCheckpointState } from './checkpointKind'

describe('readCheckpointState', () => {
  it.each([
    ['[执行中] 继续任务', { kind: 'working' }],
    ['[已停止] 停止任务', { kind: 'stopped' }],
    ['[截断] 长回复', { kind: 'abnormal', finishReason: 'length' }],
    ['[已拦截] 敏感回复', { kind: 'abnormal', finishReason: 'content_filter' }],
    ['[已中断] 资源不足', { kind: 'abnormal', finishReason: 'insufficient_system_resource' }],
  ])('兼容旧 label 前缀 %s', (label, expected) => {
    expect(readCheckpointState({ label })).toEqual(expected)
  })

  it('结构化字段优先于同一记录遗留的 label 前缀', () => {
    expect(readCheckpointState({ label: '[执行中] 旧标签', kind: 'completed' }))
      .toEqual({ kind: 'completed' })
  })

  it('没有状态字段和旧前缀的历史 checkpoint 默认为 completed', () => {
    expect(readCheckpointState({ label: '普通任务' })).toEqual({ kind: 'completed' })
  })
})
