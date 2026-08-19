// 动态尾巴顶位、压缩态归因与多因子 epochCauses 的测试;profile/epoch 身份见 contextCache.test.ts。
import { describe, expect, it } from 'vitest'
import type { ModelItem } from '@einfach-agent/ai'
import { createContextCacheTracker } from './contextCache'
import { input, system, tool, user, skill } from './contextCache.testFixtures'

describe('createContextCacheTracker · 尾巴顶位与归因', () => {
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
    // 尾巴仍会被历史顶位（skill 内容未变），但顶位只 miss 尾巴一小段 → 不再开新 epoch。
    expect(second.epoch).toBe(first.epoch)
    expect(second.epochReason).toBe(first.epochReason)
  })

  it('sessionStart 清单以请求投影配对留在首轮历史，连续追加不回退缓存 profile/epoch', () => {
    // L1 清单不再进 stable systemContent。timeline 只保存 sessionStart 的孤儿 tool result；请求
    // 投影紧贴其前补 assistant tool_call，满足供应商的配对约束。首轮真实顺序是 user → 配对 → tool。
    const timedCall: ModelItem = {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'timed:sessionStart:skill_manifest',
        type: 'function',
        function: { name: 'timed_tool_result', arguments: '{}' },
      }],
    }
    const manifest: ModelItem = {
      role: 'tool',
      tool_call_id: 'timed:sessionStart:skill_manifest',
      content: JSON.stringify('可用 skills：\n· planning — 何时用…'),
    }
    const systemContent = 'fixed system'
    const tracker = createContextCacheTracker()
    const history: ModelItem[] = [user, timedCall, manifest]
    const round = (dynamicControls: ModelItem[] = []) =>
      tracker.observe(input({
        messages: [system, ...history, ...dynamicControls],
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

  it('常驻尾巴仅被新历史顶位（内容未变）→ 同一 epoch，不再宣告失效', () => {
    const tracker = createContextCacheTracker()
    const first = tracker.observe(input({
      messages: [system, user, skill],
      dynamicControls: [skill],
    }))
    const second = tracker.observe(input({
      messages: [system, user, { role: 'assistant', content: 'answer' }, skill],
      dynamicControls: [skill],
    }))

    expect(second.epoch).toBe(first.epoch)
    expect(second.epochReason).toBe(first.epochReason)
  })

  it('回归 2026-08-04：压缩复用 + 常驻尾巴逐轮顶位 → epoch 不随轮次攀升', () => {
    // 实测形态：8 轮只读会话，投影一直复用，但每轮带 1 条尾巴控制项被新历史顶位，
    // 旧逻辑因 compacted 短路把每轮标成 compaction_projection_changed，epoch 2→7。
    const control: ModelItem = { role: 'system', content: 'plan context' }
    const tracker = createContextCacheTracker()
    const history: ModelItem[] = [user]
    const round = () => tracker.observe(input({
      messages: [system, ...history, control],
      dynamicControls: [control],
      compacted: true,
    }))

    const first = round()
    for (let turn = 0; turn < 5; turn += 1) {
      history.push({ role: 'assistant', content: `answer ${turn}` }, { role: 'user', content: `next ${turn}` })
      const next = round()
      expect(next.epoch).toBe(first.epoch)
      expect(next.epochReason).toBe(first.epochReason)
    }
  })

  it('同一轮工具集合与控制项同时变化 → epochCauses 两项都在,epochReason 只是摘要', () => {
    const tracker = createContextCacheTracker()
    const first = tracker.observe(input({
      messages: [system, user, skill],
      dynamicControls: [skill],
    }))
    expect(first.epochCauses).toEqual([])

    const changedControl: ModelItem = { role: 'system', content: 'new plan stage' }
    const second = tracker.observe(input({
      tools: [tool('request_tool_schema'), tool('read_file'), tool('rg_search')],
      messages: [system, user, { role: 'assistant', content: 'answer' }, changedControl],
      dynamicControls: [changedControl],
    }))

    expect(second.epochReason).toBe('profile_changed')
    expect(second.epochCauses).toContain('tool_set_changed')
    expect(second.epochCauses).toContain('dynamic_control_changed')
    expect(second.epochCauses).not.toContain('system_changed')

    // 无任何变化的下一轮(纯追加历史 + 同一控制项)因子归空。
    const third = tracker.observe(input({
      tools: [tool('request_tool_schema'), tool('read_file'), tool('rg_search')],
      messages: [system, user, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'next' }, changedControl],
      dynamicControls: [changedControl],
    }))
    expect(third.epochCauses).toEqual([])
    expect(third.epoch).toBe(second.epoch)
  })

  it('工具集合与 toolChoice 同轮变化 → 两个因子都在,params 不被 toolSet 吞掉(评审 D1)', () => {
    const tracker = createContextCacheTracker()
    tracker.observe(input())
    const second = tracker.observe(input({
      tools: [tool('request_tool_schema')],
      toolChoice: 'none',
    }))
    expect(second.epochReason).toBe('profile_changed')
    expect(second.epochCauses).toContain('tool_set_changed')
    expect(second.epochCauses).toContain('request_params_changed')
  })

  it('同 lane/scope 中途换模型 → model_changed,与参数变化可区分(评审 D4)', () => {
    const tracker = createContextCacheTracker()
    tracker.observe(input())
    const second = tracker.observe(input({ model: 'deepseek-v4-pro' }))
    expect(second.epochCauses).toEqual(['model_changed'])
    expect(second.epochReason).toBe('profile_changed')
  })

  it('全前缀完好、仅尾巴项改判口径 → 不记投影因子(评审 D2)', () => {
    // 两轮 messages 字节完全相同,唯一区别是最后一项从「历史」改判为 dynamicControls:
    // 投影零变化,不得输出 request_projection_changed;epoch 也不动。
    const tracker = createContextCacheTracker()
    const first = tracker.observe(input({
      messages: [system, user, skill],
    }))
    const second = tracker.observe(input({
      messages: [system, user, skill],
      dynamicControls: [skill],
    }))
    expect(second.requestProjectionFingerprint).toBe(first.requestProjectionFingerprint)
    expect(second.epoch).toBe(first.epoch)
    expect(second.epochCauses).not.toContain('request_projection_changed')
    expect(second.epochCauses).not.toContain('compaction_projection_changed')
  })

  it('压缩态下尾巴内容变化 → dynamic_control_changed，不再被 compacted 短路吞掉', () => {
    const tracker = createContextCacheTracker()
    const first = tracker.observe(input({
      messages: [system, user, skill],
      dynamicControls: [skill],
      compacted: true,
    }))
    const changed: ModelItem = { role: 'system', content: 'new plan stage' }
    const second = tracker.observe(input({
      messages: [system, user, { role: 'assistant', content: 'answer' }, changed],
      dynamicControls: [changed],
      compacted: true,
    }))

    expect(second.epoch).toBe(first.epoch + 1)
    expect(second.epochReason).toBe('dynamic_control_changed')
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
