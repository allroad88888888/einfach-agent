import { describe, expect, it } from 'vitest'
import type { ModelFunctionTool, ModelItem } from '@web-agent/ai'
import {
  createContextCacheTracker,
  type ContextCacheLane,
  type ObserveContextCacheInput,
} from './contextCache'

function tool(name: string): ModelFunctionTool {
  return {
    type: 'function',
    function: {
      name,
      description: name,
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string' },
        },
      },
    },
  }
}

const system: ModelItem = { role: 'system', content: 'fixed system' }
const user: ModelItem = { role: 'user', content: 'hello' }
const skill: ModelItem = { role: 'system', content: 'dynamic skill' }

function input(overrides: Partial<ObserveContextCacheInput> = {}): ObserveContextCacheInput {
  return {
    lane: 'main',
    scope: 'run-1:root',
    vendor: 'deepseek',
    model: 'deepseek-chat',
    messages: [system, user],
    systemContent: 'fixed system',
    tools: [tool('request_tool_schema'), tool('read_file')],
    toolChoice: 'auto',
    thinking: 'enabled',
    reasoningEffort: 'high',
    compacted: false,
    requestMode: 'tool_loop',
    ...overrides,
  }
}

describe('createContextCacheTracker', () => {
  it('相同请求以及只改变 tool 输入顺序都保持同一 profile/epoch', () => {
    const tracker = createContextCacheTracker()
    const first = tracker.observe(input())
    const second = tracker.observe(input({
      messages: [...input().messages, { role: 'assistant', content: 'next' }],
      tools: [tool('read_file'), tool('request_tool_schema')],
    }))

    expect(second.profileId).toBe(first.profileId)
    expect(second.epoch).toBe(first.epoch)
    expect(second.epochReason).toBe('initial')
    expect(second.requestProjectionFingerprint).not.toBe(first.requestProjectionFingerprint)
  })

  it('同一 epoch 的原因保持为该 epoch 的真实起因', () => {
    const tracker = createContextCacheTracker()
    tracker.observe(input())
    const changed = tracker.observe(input({ requestMode: 'final_synthesis' }))
    const unchanged = tracker.observe(input({ requestMode: 'final_synthesis' }))

    expect(changed.epoch).toBe(2)
    expect(changed.epochReason).toBe('profile_changed')
    expect(unchanged.epoch).toBe(changed.epoch)
    expect(unchanged.epochReason).toBe(changed.epochReason)
  })

  it('模型、tool、thinking、toolChoice、system 和 requestMode 变化会单调切换 epoch', () => {
    const mutations: Array<Partial<ObserveContextCacheInput>> = [
      { model: 'deepseek-reasoner' },
      { tools: [tool('request_tool_schema')] },
      { thinking: 'disabled' },
      { toolChoice: 'none' },
      { systemContent: 'new fixed system', messages: [{ role: 'system', content: 'new fixed system' }, user] },
      { requestMode: 'final_synthesis' },
    ]

    for (const mutation of mutations) {
      const tracker = createContextCacheTracker()
      const first = tracker.observe(input())
      const second = tracker.observe(input(mutation))
      expect(second.epoch).toBe(first.epoch + 1)
      expect(second.epochReason).toBe('profile_changed')
      expect(second.profileId).not.toBe(first.profileId)
    }
  })

  it('五类 lane 使用彼此独立的 profile', () => {
    const lanes: ContextCacheLane[] = [
      'main',
      'subagent',
      'evaluator',
      'distill:core',
      'distill:child_brief',
    ]
    const tracker = createContextCacheTracker()
    const profiles = lanes.map((lane) => tracker.observe(input({ lane })).profileId)

    expect(new Set(profiles).size).toBe(lanes.length)
  })

  it('动态尾部前插入新历史会推进 epoch 并说明原因', () => {
    const tracker = createContextCacheTracker()
    const first = tracker.observe(input({
      messages: [system, user, skill],
      dynamicControls: [skill],
    }))
    const second = tracker.observe(input({
      messages: [system, user, { role: 'assistant', content: 'answer' }, skill],
      dynamicControls: [skill],
    }))

    expect(second.epoch).toBe(first.epoch + 1)
    expect(second.epochReason).toBe('history_inserted_before_dynamic_tail')
  })

  it('动态控制变化与压缩投影重写使用明确的 epoch 原因', () => {
    const dynamicTracker = createContextCacheTracker()
    dynamicTracker.observe(input({
      messages: [system, user, skill],
      dynamicControls: [skill],
    }))
    const changedControl: ModelItem = { role: 'system', content: 'new plan' }
    const dynamic = dynamicTracker.observe(input({
      messages: [system, user, changedControl],
      dynamicControls: [changedControl],
    }))
    expect(dynamic.epochReason).toBe('dynamic_control_changed')

    const compactedTracker = createContextCacheTracker()
    const first = compactedTracker.observe(input())
    const compacted = compactedTracker.observe(input({
      messages: [system, { role: 'user', content: 'compacted projection' }],
      compacted: true,
    }))
    expect(compacted.epoch).toBe(first.epoch + 1)
    expect(compacted.epochReason).toBe('compaction_projection_changed')
  })
})
