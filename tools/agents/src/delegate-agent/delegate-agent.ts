// tools/delegate-agent/delegate-agent.ts -- tree-shaped child-agent delegation.
import type { Tool, ToolContext } from '@web-agent/core/tools/types'
import { normalizeDelegateAgentInput } from '@web-agent/core/subagents/input'
import guide from './delegate-agent.md?raw'

const inputSchema = {
  type: 'object',
  properties: {
    children: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          objective: { type: 'string' },
          mode: { type: 'string' },
          expectedOutput: { type: 'string' },
          maxDepth: { type: 'integer', minimum: 1 },
          maxChildren: { type: 'integer', minimum: 1 },
          maxTurns: { type: 'integer', minimum: 1 },
          toolProfile: { type: 'string', enum: ['delegate_only', 'workspace_read'] },
          confirmedTools: {
            type: 'array',
            uniqueItems: true,
            items: { type: 'string', enum: ['shell_macos', 'shell_linux', 'shell_powershell', 'write_file', 'apply_patch', 'delete_path', 'copy_path', 'move_path', 'revert_workspace_change'] },
          },
        },
        required: ['objective'],
      },
    },
    strategy: {
      type: 'string',
      enum: ['parallel_wait_all', 'parallel_best_effort'],
      default: 'parallel_wait_all',
    },
    maxDepth: { type: 'integer', minimum: 1, default: 2 },
    maxChildren: { type: 'integer', minimum: 1, default: 6 },
    maxConcurrent: { type: 'integer', minimum: 1, default: 4 },
    maxTotalNodes: { type: 'integer', minimum: 1, maximum: 256, default: 64 },
    maxModelCalls: { type: 'integer', minimum: 1, maximum: 512, default: 128 },
    toolProfile: {
      type: 'string',
      enum: ['delegate_only', 'workspace_read'],
      default: 'delegate_only',
      description: 'Child tool capability ceiling. Descendants may inherit or narrow it, never widen it.',
    },
    confirmedTools: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', enum: ['shell_macos', 'shell_linux', 'shell_powershell', 'write_file', 'apply_patch', 'delete_path', 'copy_path', 'move_path', 'revert_workspace_change'] },
      description: 'Dangerous tools requested from a host-issued capability scoped to this delegation. Omission means none.',
    },
  },
  required: ['children'],
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  return 'delegate_agent failed'
}

function getDelegateAgents(ctx: ToolContext): ToolContext['delegateAgents'] {
  const candidate = (ctx as { delegateAgents?: unknown }).delegateAgents
  return typeof candidate === 'function' ? candidate.bind(ctx) : undefined
}

function getSpawnAgents(ctx: ToolContext): ToolContext['spawnAgents'] {
  const candidate = (ctx as { spawnAgents?: unknown }).spawnAgents
  return typeof candidate === 'function' ? candidate.bind(ctx) : undefined
}

function inputPreservingOptionalPresence(
  raw: unknown,
  normalized: ReturnType<typeof normalizeDelegateAgentInput> & { ok: true },
) {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const input = { children: normalized.input.children } as typeof normalized.input
  for (const key of [
    'strategy',
    'maxDepth',
    'maxChildren',
    'maxConcurrent',
    'maxTotalNodes',
    'maxModelCalls',
    'toolProfile',
    'confirmedTools',
  ] as const) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      Object.assign(input, { [key]: normalized.input[key] })
    }
  }
  return input
}

export const delegateAgentTool: Tool = {
  name: 'delegate_agent',
  runtime: 'internal',
  skill: {
    description: '并发启动一批树形 headless 子 agent，并把结构化结果回填给父 agent。',
    triggers: ['delegate', 'subagent', '子agent', '并发分析', '派活'],
    content: guide,
  },
  inputSchema,
  async execute(args, ctx) {
    const normalized = normalizeDelegateAgentInput(args)
    if (!normalized.ok) return { ok: false, error: normalized.error }

    const spawnAgents = getSpawnAgents(ctx)
    const delegateAgents = getDelegateAgents(ctx)
    if (!spawnAgents && !delegateAgents) {
      return { ok: false, error: 'delegate_agent unavailable: ctx.delegateAgents is not configured' }
    }

    try {
      ctx.progress(`派发 ${normalized.input.children.length} 个子 agent`)
      // Presence matters for inherited tree budgets/profiles: an omitted nested option inherits,
      // while an explicit option may only narrow. Do not materialize normalization defaults here.
      const input = inputPreservingOptionalPresence(args, normalized)
      if (spawnAgents) {
        return { ok: true, data: spawnAgents(input) }
      }
      const result = await delegateAgents!(input)
      return { ok: true, data: result }
    } catch (error) {
      return { ok: false, error: toErrorMessage(error) }
    }
  },
}
