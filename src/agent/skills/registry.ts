import type { LoadedSkill, SkillSummary } from '../runtime/types'
import askUserQuestion from './ask-user-question.md?raw'
import toolLoading from './tool-loading.md?raw'
import webChatAgent from './web-chat-agent.md?raw'

type SkillSource = {
  name: string
  description: string
  triggers: string[]
  content: string
}

const skillSources: SkillSource[] = [
  {
    name: 'ask-user-question',
    description: '当任务信息不足时暂停 agent loop，向用户收集必要决策。',
    triggers: ['提问', '确认', '不明确', 'ask user'],
    content: askUserQuestion,
  },
  {
    name: 'tool-loading',
    description: '工具只先暴露摘要，需要时再加载完整 schema。',
    triggers: ['tool', '工具', '延迟加载', 'lazy loading'],
    content: toolLoading,
  },
  {
    name: 'web-chat-agent',
    description: 'Web 端 chat agent 的最小运行时边界。',
    triggers: ['web agent', 'chat', '前端', 'runtime'],
    content: webChatAgent,
  },
]

export function listSkillSummaries(): SkillSummary[] {
  return skillSources.map(({ name, description, triggers }) => ({ name, description, triggers }))
}

export function searchSkills(query: string): SkillSummary[] {
  const normalizedQuery = query.toLowerCase()
  return listSkillSummaries().filter((skill) => {
    const searchable = [skill.name, skill.description, ...skill.triggers].join(' ').toLowerCase()
    return searchable.includes(normalizedQuery) || skill.triggers.some((trigger) => normalizedQuery.includes(trigger.toLowerCase()))
  })
}

export function readSkill(name: string): LoadedSkill | undefined {
  const source = skillSources.find((skill) => skill.name === name)
  if (!source) return undefined

  return {
    name: source.name,
    description: source.description,
    triggers: source.triggers,
    content: source.content,
  }
}

export function pickSkillsForInput(input: string): LoadedSkill[] {
  const normalizedInput = input.toLowerCase()
  const selected = skillSources.filter((skill) =>
    skill.triggers.some((trigger) => normalizedInput.includes(trigger.toLowerCase())),
  )

  if (!selected.some((skill) => skill.name === 'web-chat-agent')) {
    const baseSkill = readSkill('web-chat-agent')
    if (baseSkill) selected.unshift(baseSkill)
  }

  return selected.map((skill) => ({
    name: skill.name,
    description: skill.description,
    triggers: skill.triggers,
    content: skill.content,
  }))
}
