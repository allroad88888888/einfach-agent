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

  it('自定义指令不变时，历史增长不再让它每轮换位置（尾巴只剩真正动态的控制消息）', () => {
    const instructions: ModelItem = { role: 'system', content: '请始终使用中文回复' }
    const systemContent = `fixed system\n${instructions.content}`
    const tracker = createContextCacheTracker()
    const first = tracker.observe(input({
      messages: [system, instructions, user, skill],
      systemContent,
      dynamicControls: [skill],
    }))
    const second = tracker.observe(input({
      messages: [system, instructions, user, { role: 'assistant', content: 'answer' }, skill],
      systemContent,
      dynamicControls: [skill],
    }))

    expect(second.profileId).toBe(first.profileId)
    expect(second.systemFingerprint).toBe(first.systemFingerprint)
    // 尾巴仍会被历史顶位（skill 本就该随输入变），但自定义指令已不在被顶的那一段里。
    expect(second.epochReason).toBe('history_inserted_before_dynamic_tail')
  })

  it('尾巴为空时，纯追加的连续多轮不再 bump epoch（阶段 3：skill 清单迁出尾巴的核心收益）', () => {
    // 阶段 3 之前，skill 名单是常驻动态尾巴项，历史每追加一轮都把它顶到新位置 →
    // 每轮 history_inserted_before_dynamic_tail、epoch +1、整段前缀全额 miss（实测 185/185 轮）。
    // 清单迁进稳定前缀后，多数轮次 dynamicControls 为空，新历史只是往投影尾部 append。
    const manifest: ModelItem = { role: 'system', content: '可用 skills：· planning — 何时用…' }
    const systemContent = `fixed system\n${manifest.content}`
    const tracker = createContextCacheTracker()
    const history: ModelItem[] = [user]
    const round = (dynamicControls: ModelItem[] = []) =>
      tracker.observe(input({
        messages: [system, manifest, ...history, ...dynamicControls],
        systemContent,
        dynamicControls,
      }))

    const first = round()
    expect(first.epoch).toBe(1)

    // 连续 3 轮纯追加（assistant 回复 + 用户下一句），尾巴始终为空。
    for (let turn = 0; turn < 3; turn += 1) {
      history.push({ role: 'assistant', content: `answer ${turn}` }, { role: 'user', content: `next ${turn}` })
      const next = round()
      expect(next.epoch).toBe(1)
      expect(next.epochReason).toBe('initial')
      expect(next.profileId).toBe(first.profileId)
      // 投影确实在变（历史真的长了），只是变化是纯追加，前缀边界未被破坏。
      expect(next.requestProjectionFingerprint).not.toBe(first.requestProjectionFingerprint)
    }

    // 第 4 轮出现一条事件驱动尾巴项（如工具失败提醒）：它挂在全部历史之后，仍是纯追加 →
    // 前缀依旧命中，epoch 不动。
    const notice: ModelItem = { role: 'system', content: '连续两次工具失败，请先检查参数' }
    history.push({ role: 'assistant', content: 'answer 3' }, { role: 'user', content: 'next 3' })
    const withNotice = round([notice])
    expect(withNotice.epoch).toBe(1)

    // 第 5 轮：一次性提醒被消费掉、历史继续增长 —— 上一轮那条尾巴项的位置现在是新历史，
    // 前缀第一次真的被破坏 → 恰好 bump 一次，归因为尾巴控制项变化。
    history.push({ role: 'assistant', content: 'answer 4' }, { role: 'user', content: 'next 4' })
    const afterNotice = round()
    expect(afterNotice.epoch).toBe(2)
    expect(afterNotice.epochReason).toBe('dynamic_control_changed')
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
