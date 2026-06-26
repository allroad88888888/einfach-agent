import type { LoadedTool, ToolSummary } from '../runtime/types'

const toolSummaries: ToolSummary[] = [
  {
    name: 'ask_user_question',
    description: '暂停当前 run，向用户提出一个或多个结构化问题并收集缺失决策。',
    runtime: 'internal',
  },
  {
    name: 'skill_search',
    description: '按名称、描述或触发词搜索仓库 skills。',
    runtime: 'internal',
  },
  {
    name: 'skill_read',
    description: '读取已选中的仓库 skill 内容。',
    runtime: 'internal',
  },
  {
    name: 'delegate_agent',
    description: '把独立任务委托给 worker agent。',
    runtime: 'internal',
  },
  {
    name: 'browser_action',
    description: '渲染信息卡片到对话流（render_card）。',
    runtime: 'browser',
  },
  {
    name: 'save_file',
    description: '准备一份文件内容供用户在浏览器内手势保存到本地（File System Access）。',
    runtime: 'browser',
  },
]

const toolSchemas: Record<string, Record<string, unknown>> = {
  ask_user_question: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string' },
      questions: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'text', 'type'],
          properties: {
            id: { type: 'string' },
            text: { type: 'string' },
            type: { enum: ['text', 'single-choice', 'multi-choice', 'confirm'] },
            options: { type: 'array', items: { type: 'string' } },
            required: { type: 'boolean' },
          },
        },
      },
    },
    required: ['id', 'questions'],
  },
  skill_search: {
    type: 'object',
    properties: {
      query: { type: 'string' },
    },
    required: ['query'],
  },
  skill_read: {
    type: 'object',
    properties: {
      name: { type: 'string' },
    },
    required: ['name'],
  },
  delegate_agent: {
    type: 'object',
    properties: {
      agentId: { enum: ['skill-worker', 'tool-worker', 'answer-worker', 'clarifier-worker'] },
      instruction: { type: 'string' },
    },
    required: ['agentId', 'instruction'],
  },
  browser_action: {
    type: 'object',
    properties: {
      action: { enum: ['render_card'] },
      payload: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
          items: { type: 'array', items: { type: 'string' } },
          options: { type: 'array', items: { type: 'string' } },
        },
        required: ['title'],
      },
    },
    required: ['action', 'payload'],
  },
  save_file: {
    type: 'object',
    properties: {
      filename: { type: 'string' },
      content: { type: 'string' },
      mimeType: { type: 'string' },
    },
    required: ['filename', 'content'],
  },
}

export function listToolSummaries(): ToolSummary[] {
  return toolSummaries
}

export function searchTools(query: string): ToolSummary[] {
  const normalizedQuery = query.toLowerCase()
  return toolSummaries.filter((tool) => {
    const searchable = [tool.name, tool.description, tool.runtime].join(' ').toLowerCase()
    return searchable.includes(normalizedQuery)
  })
}

export function loadTool(name: string): LoadedTool | undefined {
  const summary = toolSummaries.find((tool) => tool.name === name)
  if (!summary) return undefined

  return {
    ...summary,
    inputSchema: toolSchemas[name] ?? {},
  }
}
