import { describe, it, expect } from 'vitest'
import {
  listSkillSummaries,
  searchSkills,
  readSkill,
  pickSkillsForInput,
} from './registry'

describe('skills/registry（agentNew · 移植版）', () => {
  it('pickSkillsForInput 对任意输入都总是含 web-chat-agent（base skill 必带，TK4）', () => {
    const picked = pickSkillsForInput('随便一句话')
    const names = picked.map((skill) => skill.name)

    expect(names).toContain('web-chat-agent')
    // 未命中任何触发词时，base skill 被 unshift 到最前。
    expect(names[0]).toBe('web-chat-agent')
  })

  it('输入含某 skill 的触发词 → 该 skill 被选中', () => {
    const picked = pickSkillsForInput('帮我画一个 echarts 柱状图')
    const names = picked.map((skill) => skill.name)

    expect(names).toContain('data-visualization')
    // base skill 仍在。
    expect(names).toContain('web-chat-agent')
  })

  it('命中触发词的 skill 附带非空 content（LoadedSkill）', () => {
    const picked = pickSkillsForInput('这个 tool 需要延迟加载')
    const toolLoading = picked.find((skill) => skill.name === 'tool-loading')

    expect(toolLoading).toBeDefined()
    expect(typeof toolLoading?.content).toBe('string')
    expect(toolLoading?.content.length).toBeGreaterThan(0)
  })

  it('readSkill(web-chat-agent) 返回 content 非空', () => {
    const skill = readSkill('web-chat-agent')

    expect(skill).toBeDefined()
    expect(skill?.name).toBe('web-chat-agent')
    expect(typeof skill?.content).toBe('string')
    expect(skill?.content.length).toBeGreaterThan(0)
  })

  it('readSkill 未知名字返回 undefined', () => {
    expect(readSkill('nope')).toBeUndefined()
  })

  it('listSkillSummaries 每项都是 summary-only（无 content 键）', () => {
    const summaries = listSkillSummaries()

    expect(summaries.length).toBeGreaterThan(0)
    for (const summary of summaries) {
      expect(summary).not.toHaveProperty('content')
      expect(summary.name).toBeTruthy()
      expect(summary.description).toBeTruthy()
      expect(Array.isArray(summary.triggers)).toBe(true)
    }
  })

  it('searchSkills 按 name/description/triggers 双向子串匹配', () => {
    // query 是触发词的子串（searchable 命中）。
    const byTrigger = searchSkills('echarts').map((skill) => skill.name)
    expect(byTrigger).toContain('data-visualization')

    // query 反向包含触发词（normalizedQuery.includes(trigger)）。
    const byReverse = searchSkills('请帮我提问确认一下').map((skill) => skill.name)
    expect(byReverse).toContain('ask-user-question')
  })
})
