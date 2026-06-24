import { describe, expect, it } from 'vitest'
import { listSkillSummaries, pickSkillsForInput, readSkill, searchSkills } from './registry'

describe('skill registry', () => {
  it('lists only skill summaries by default', () => {
    const skills = listSkillSummaries()

    expect(skills.map((skill) => skill.name)).toEqual([
      'ask-user-question',
      'tool-loading',
      'web-chat-agent',
    ])
    expect(skills[0]).not.toHaveProperty('content')
  })

  it('searches by name, description, and trigger text', () => {
    expect(searchSkills('提问').map((skill) => skill.name)).toContain('ask-user-question')
    expect(searchSkills('延迟加载').map((skill) => skill.name)).toContain('tool-loading')
    expect(searchSkills('前端').map((skill) => skill.name)).toContain('web-chat-agent')
  })

  it('reads full repository skill content only after selection', () => {
    const skill = readSkill('ask-user-question')

    expect(skill?.content).toContain('# AskUserQuestion Skill')
    expect(readSkill('missing-skill')).toBeUndefined()
  })

  it('always includes the base web chat skill for user input', () => {
    expect(pickSkillsForInput('普通任务').map((skill) => skill.name)).toEqual(['web-chat-agent'])

    expect(pickSkillsForInput('需要lazy loading').map((skill) => skill.name)).toEqual([
      'web-chat-agent',
      'tool-loading',
    ])
  })
})
