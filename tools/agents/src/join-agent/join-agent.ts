import type { Tool } from '@web-agent/core/tools/types'
import guide from './join-agent.md?raw'

export const joinAgentTool: Tool = {
  name: 'join_agent',
  runtime: 'internal',
  skill: {
    description: '显式等待一个后台子 agent 执行并取得结果。',
    triggers: ['join agent', 'wait agent', '等待子agent'],
    content: guide,
  },
  inputSchema: {
    type: 'object',
    properties: {
      executionId: { type: 'string' },
    },
    required: ['executionId'],
  },
  async execute(args, ctx) {
    if (!ctx.joinExecution) {
      return { ok: false, error: 'join_agent unavailable' }
    }
    const executionId = (args as { executionId: string }).executionId
    const result = await ctx.joinExecution(executionId)
    if (result.status === 'failed') {
      return { ok: false, error: result.error ?? `execution failed: ${executionId}` }
    }
    return { ok: true, data: result }
  },
}
