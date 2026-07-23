// skills/registry.ts（agentNew · 从 src/agent/skills/registry.ts 移植）
// ---------------------------------------------------------------------------
// TK4：skill 走 tool、不进 prompt —— system 只放「已加载 skills：<names>」，
// model 要读内容必须调 skill_read。这里只负责按触发词选 skill + 提供读取。
// 类型自包含（不 import runtime/state/UI），与 src/agent 版语义一致。

import askUserQuestion from './ask-user-question.md?raw'
import dataVisualization from './data-visualization.md?raw'
import toolLoading from './tool-loading.md?raw'
import webChatAgent from './web-chat-agent.md?raw'
import planning from './planning.md?raw'

export interface SkillSummary {
  name: string
  description: string
  triggers: string[]
}

export interface LoadedSkill extends SkillSummary {
  content: string
}

type SkillSource = {
  name: string
  description: string
  triggers: string[]
  content: string
}

const skillSources: SkillSource[] = [
  {
    name: 'planning',
    description: '把复杂任务建模为可审批、可执行、可验证的分阶段计划。',
    triggers: ['plan', '规划', '阶段', '路线图', '多步骤', 'migration', '架构', '重构', '并发'],
    content: planning,
  },
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
  {
    name: 'data-visualization',
    description: '需要图表或高亮代码时，在 assistant 回复里用代码围栏让前端 Markdown 自动渲染。',
    triggers: ['图表', '可视化', 'chart', 'echarts', '绘图', '代码高亮'],
    content: dataVisualization,
  },
]

export function listSkillSummaries(): SkillSummary[] {
  return skillSources.map(({ name, description, triggers }) => ({ name, description, triggers }))
}

export function searchSkills(query: string): SkillSummary[] {
  const normalizedQuery = query.toLowerCase()
  return listSkillSummaries().filter((skill) => {
    const searchable = [skill.name, skill.description, ...skill.triggers].join(' ').toLowerCase()
    return (
      searchable.includes(normalizedQuery) ||
      skill.triggers.some((trigger) => normalizedQuery.includes(trigger.toLowerCase()))
    )
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

  // 复杂任务即使没有出现“plan/规划”也自动加载 planning。它是启发式入口，最终是否建计划由模型结合语义判断。
  const planningSignals = [
    /多个|多处|多模块|全链路|整体|完整实现|从.+到.+|先.+再.+|同时|以及.*测试|实现.*(?:测试|文档)/i,
    /migrat|refactor|architect|multi.?agent|parallel|end.?to.?end|implement.*(?:test|document)/i,
  ]
  const hasComplexStructure = input.length >= 120 && /[，,；;。\n]/.test(input)
  if ((hasComplexStructure || planningSignals.some((pattern) => pattern.test(input)))
    && !selected.some((skill) => skill.name === 'planning')) {
    const planningSkill = readSkill('planning')
    if (planningSkill) selected.push(planningSkill)
  }

  // TK4：总是含 web-chat-agent —— 未命中则 unshift 到最前。
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
