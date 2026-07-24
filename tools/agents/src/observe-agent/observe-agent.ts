import type { Tool } from '@web-agent/core/tools/types'
import guide from './observe-agent.md?raw'

export const observeAgentTool: Tool = {
  name: 'observe_agent',
  execution: { mode: 'parallel', effectKeys: ['execution:read'] },
  runtime: 'internal',
  skill: {
    description: '读取后台子 agent 执行状态，不等待完成。',
    triggers: ['observe agent', 'agent status', '子agent状态'],
    content: guide,
  },
  inputSchema: {
    type: 'object',
    properties: {
      executionId: { type: 'string' },
    },
    required: ['executionId'],
  },
  execute(args, ctx) {
    if (!ctx.observeExecution) {
      return { ok: false, error: 'observe_agent unavailable' }
    }
    const executionId = (args as { executionId: string }).executionId
    const observation = ctx.observeExecution(executionId)
    if (!observation.node) {
      return { ok: false, error: `unknown execution: ${executionId}` }
    }
    return { ok: true, data: observation }
  },
}
