import type {
  DelegateAgentChildSpec,
  DelegateAgentInput,
  DelegateAgentStrategy,
  SubagentModelTier,
  SubagentRiskLevel,
  SubagentTaskCategory,
  SubagentToolProfile,
} from './types'
import {
  DEFAULT_SUBAGENT_TOOL_PROFILE,
  SUBAGENT_TOOL_PROFILES,
} from './toolProfile'
import { isDelegatableDangerousTool } from '../runtime/dangerousTools'

const DEFAULT_MAX_CHILDREN = 6
const HARD_MAX_CHILDREN = 12
const DEFAULT_MAX_CONCURRENT = 4
const HARD_MAX_CONCURRENT = 8
const DEFAULT_MAX_DEPTH = 2
const HARD_MAX_DEPTH = 6
// maxTurns 包含最后一次“只输出结论”的收尾调用。复杂评估需要多轮只读检索，
// 8 轮会让 schema 探索/大仓库核验很容易撞顶；仍保留硬上限，避免无界循环。
const HARD_MAX_TURNS = 16
const DEFAULT_MAX_TOTAL_NODES = 64
const HARD_MAX_TOTAL_NODES = 256
const DEFAULT_MAX_MODEL_CALLS = 128
const HARD_MAX_MODEL_CALLS = 512

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), max)
}

function optionalPositiveInt(value: unknown, max: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.min(Math.floor(value), max)
}

function normalizeStrategy(value: unknown): DelegateAgentStrategy {
  return value === 'parallel_best_effort' ? 'parallel_best_effort' : 'parallel_wait_all'
}

// 从单一真源派生，避免新增档位后错误文案漏改。
const TOOL_PROFILE_LIST = SUBAGENT_TOOL_PROFILES.join(', ')
function normalizeToolProfile(value: unknown): SubagentToolProfile | undefined {
  return SUBAGENT_TOOL_PROFILES.includes(value as SubagentToolProfile)
    ? (value as SubagentToolProfile)
    : undefined
}

function normalizeModelTier(value: unknown): SubagentModelTier | undefined {
  return value === 'pro' || value === 'flash' ? value : undefined
}

function normalizeTaskCategory(value: unknown): SubagentTaskCategory | undefined {
  return value === 'retrieval'
    || value === 'extraction'
    || value === 'analysis'
    || value === 'implementation'
    || value === 'verification'
    || value === 'final_acceptance'
    ? value
    : undefined
}

function normalizeRiskLevel(value: unknown): SubagentRiskLevel | undefined {
  return value === 'low' || value === 'medium' || value === 'high' ? value : undefined
}

function optionalNonNegativeInt(value: unknown, max: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return undefined
  return Math.min(value, max)
}

function normalizeConfirmedTools(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const names: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !isDelegatableDangerousTool(item)) return undefined
    if (!names.includes(item)) names.push(item)
  }
  return names
}

export function normalizeDelegateAgentInput(value: unknown):
  | { ok: true; input: DelegateAgentInput }
  | { ok: false; error: string } {
  const record = asRecord(value)
  const childrenValue = record.children
  if (!Array.isArray(childrenValue) || childrenValue.length === 0) {
    return { ok: false, error: 'invalid delegate_agent: children must be a non-empty array' }
  }

  const maxChildren = positiveInt(record.maxChildren, DEFAULT_MAX_CHILDREN, HARD_MAX_CHILDREN)
  if (childrenValue.length > maxChildren) {
    return {
      ok: false,
      error: `invalid delegate_agent: children length ${childrenValue.length} exceeds maxChildren ${maxChildren}`,
    }
  }

  const children: DelegateAgentChildSpec[] = []
  for (const childValue of childrenValue) {
    const child = asRecord(childValue)
    const objective = typeof child.objective === 'string' ? child.objective.trim() : ''
    if (!objective) {
      return { ok: false, error: 'invalid delegate_agent: every child objective must be a non-empty string' }
    }
    const spec: DelegateAgentChildSpec = { objective }
    if (typeof child.mode === 'string' && child.mode.trim()) spec.mode = child.mode.trim()
    if (typeof child.expectedOutput === 'string' && child.expectedOutput.trim()) {
      spec.expectedOutput = child.expectedOutput.trim()
    }
    if (child.modelTier !== undefined) {
      const modelTier = normalizeModelTier(child.modelTier)
      if (!modelTier) {
        return { ok: false, error: 'invalid delegate_agent: child modelTier must be pro or flash' }
      }
      spec.modelTier = modelTier
    }
    if (child.taskCategory !== undefined) {
      const taskCategory = normalizeTaskCategory(child.taskCategory)
      if (!taskCategory) {
        return {
          ok: false,
          error: 'invalid delegate_agent: child taskCategory must be retrieval, extraction, analysis, implementation, verification, or final_acceptance',
        }
      }
      spec.taskCategory = taskCategory
    }
    if (child.riskLevel !== undefined) {
      const riskLevel = normalizeRiskLevel(child.riskLevel)
      if (!riskLevel) {
        return {
          ok: false,
          error: 'invalid delegate_agent: child riskLevel must be low, medium, or high',
        }
      }
      spec.riskLevel = riskLevel
    }
    if (child.crossModule !== undefined) {
      if (typeof child.crossModule !== 'boolean') {
        return { ok: false, error: 'invalid delegate_agent: child crossModule must be boolean' }
      }
      spec.crossModule = child.crossModule
    }
    if (child.requiresTemporalNormalization !== undefined) {
      if (typeof child.requiresTemporalNormalization !== 'boolean') {
        return {
          ok: false,
          error: 'invalid delegate_agent: child requiresTemporalNormalization must be boolean',
        }
      }
      spec.requiresTemporalNormalization = child.requiresTemporalNormalization
    }
    if (child.finalAcceptance !== undefined) {
      if (typeof child.finalAcceptance !== 'boolean') {
        return { ok: false, error: 'invalid delegate_agent: child finalAcceptance must be boolean' }
      }
      spec.finalAcceptance = child.finalAcceptance
    }
    if (child.priorFailureCount !== undefined) {
      const priorFailureCount = optionalNonNegativeInt(child.priorFailureCount, 100)
      if (priorFailureCount === undefined) {
        return {
          ok: false,
          error: 'invalid delegate_agent: child priorFailureCount must be a non-negative integer',
        }
      }
      spec.priorFailureCount = priorFailureCount
    }
    const childMaxDepth = optionalPositiveInt(child.maxDepth, HARD_MAX_DEPTH)
    if (childMaxDepth !== undefined) spec.maxDepth = childMaxDepth
    const childMaxChildren = optionalPositiveInt(child.maxChildren, HARD_MAX_CHILDREN)
    if (childMaxChildren !== undefined) spec.maxChildren = childMaxChildren
    const childMaxTurns = optionalPositiveInt(child.maxTurns, HARD_MAX_TURNS)
    if (childMaxTurns !== undefined) spec.maxTurns = childMaxTurns
    if (child.toolProfile !== undefined) {
      const childToolProfile = normalizeToolProfile(child.toolProfile)
      if (!childToolProfile) {
        return { ok: false, error: `invalid delegate_agent: child toolProfile must be one of ${TOOL_PROFILE_LIST}` }
      }
      spec.toolProfile = childToolProfile
    }
    if (child.confirmedTools !== undefined) {
      const childConfirmedTools = normalizeConfirmedTools(child.confirmedTools)
      if (!childConfirmedTools) {
        return { ok: false, error: 'invalid delegate_agent: child confirmedTools must contain only dangerous tool names' }
      }
      spec.confirmedTools = childConfirmedTools
    }
    children.push(spec)
  }

  const toolProfile = record.toolProfile === undefined
    ? DEFAULT_SUBAGENT_TOOL_PROFILE
    : normalizeToolProfile(record.toolProfile)
  if (!toolProfile) {
    return { ok: false, error: `invalid delegate_agent: toolProfile must be one of ${TOOL_PROFILE_LIST}` }
  }

  const confirmedTools = record.confirmedTools === undefined
    ? undefined
    : normalizeConfirmedTools(record.confirmedTools)
  if (!confirmedTools && record.confirmedTools !== undefined) {
    return { ok: false, error: 'invalid delegate_agent: confirmedTools must contain only dangerous tool names' }
  }

  return {
    ok: true,
    input: {
      children,
      strategy: normalizeStrategy(record.strategy),
      maxDepth: positiveInt(record.maxDepth, DEFAULT_MAX_DEPTH, HARD_MAX_DEPTH),
      maxChildren,
      maxConcurrent: positiveInt(record.maxConcurrent, DEFAULT_MAX_CONCURRENT, HARD_MAX_CONCURRENT),
      maxTotalNodes: positiveInt(record.maxTotalNodes, DEFAULT_MAX_TOTAL_NODES, HARD_MAX_TOTAL_NODES),
      maxModelCalls: positiveInt(record.maxModelCalls, DEFAULT_MAX_MODEL_CALLS, HARD_MAX_MODEL_CALLS),
      toolProfile,
      ...(confirmedTools ? { confirmedTools } : {}),
    },
  }
}
