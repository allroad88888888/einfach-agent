// profile / epoch 身份判定的测试;动态尾巴顶位与多因子归因见 contextCache.attribution.test.ts。
import { describe, expect, it } from 'vitest'
import type { ModelItem } from '@einfach-agent/ai'
import {
  createContextCacheTracker,
  type ContextCacheLane,
  type ObserveContextCacheInput,
} from './contextCache'
import { input, system, tool, user, skill } from './contextCache.testFixtures'

describe('createContextCacheTracker · profile/epoch 身份', () => {
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

  it('自定义指令改动稳定前缀 → profile_changed，而不是尾巴/投影变化', () => {
    // 主循环把「固定 system + 自定义指令」整体作为 systemContent 传进来，两条都在历史之前。
    const instructions: ModelItem = { role: 'system', content: '请始终使用中文回复' }
    const nextInstructions: ModelItem = { role: 'system', content: '请始终使用英文回复' }
    const tracker = createContextCacheTracker()
    const first = tracker.observe(input({
      messages: [system, instructions, user, skill],
      systemContent: `fixed system\n${instructions.content}`,
      dynamicControls: [skill],
    }))
    const second = tracker.observe(input({
      messages: [system, nextInstructions, user, skill],
      systemContent: `fixed system\n${nextInstructions.content}`,
      dynamicControls: [skill],
    }))

    expect(second.epoch).toBe(first.epoch + 1)
    expect(second.epochReason).toBe('profile_changed')
    expect(second.systemFingerprint).not.toBe(first.systemFingerprint)
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
})
