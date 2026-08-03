import type {
  ModelFunctionTool,
  ModelItem,
  ModelToolChoice,
} from '@web-agent/ai'
import { toolSetSchemaFingerprint } from './modelTurn'
import { fnv1a32 } from './shared/hash'

export const CONTEXT_CACHE_PROTOCOL_VERSION = 'agent-runtime-prefix-v2'

export type ContextCacheLane =
  | 'main'
  | 'subagent'
  | 'evaluator'
  | 'distill:core'
  | 'distill:child_brief'

export type ContextCacheEpochReason =
  | 'initial'
  | 'profile_changed'
  | 'dynamic_control_changed'
  | 'history_inserted_before_dynamic_tail'
  | 'compaction_projection_changed'
  | 'request_projection_changed'

export type ContextCacheCompactionBoundary = 'full-history' | 'compacted-history'

export interface ContextCacheProfile {
  lane: ContextCacheLane
  laneScopeFingerprint: string
  profileId: string
  epoch: number
  epochReason: ContextCacheEpochReason
  protocolVersion: string
  toolSetFingerprint: string
  systemFingerprint: string
  requestProjectionFingerprint: string
  compactionBoundary: ContextCacheCompactionBoundary
}

export interface ObserveContextCacheInput {
  lane: ContextCacheLane
  /**
   * lane 的本地归属，例如 runId + agentPath。只会保存它的指纹，不会进入 trace/UI。
   */
  scope: string
  vendor: string
  model: string
  messages: readonly ModelItem[]
  /**
   * 本 lane 稳定前缀的全部正文（不只是第一条 system）。主循环传「固定 system + 自定义指令」
   * 的拼接：前缀字节一变就应换 profile（profile_changed / 新 epoch），而不是被下面的
   * dynamicControls / 投影比较误判成尾巴变化。
   */
  systemContent: string
  tools: readonly ModelFunctionTool[]
  toolChoice?: ModelToolChoice
  thinking?: 'enabled' | 'disabled'
  reasoningEffort?: string
  compacted: boolean
  /**
   * 放在事实历史末尾、下一轮可能被新历史插到前面的控制消息，例如 skill/plan/continue。
   */
  dynamicControls?: readonly ModelItem[]
  requestMode?: string
}

interface LaneState {
  epoch: number
  epochReason: ContextCacheEpochReason
  profileId: string
  projectionItemFingerprints: string[]
  compacted: boolean
  dynamicControlFingerprint: string
  dynamicTailCount: number
}

export interface ContextCacheTracker {
  observe(input: ObserveContextCacheInput): ContextCacheProfile
}

function canonicalSerialize(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return '"[undefined]"'
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalSerialize(item)).join(',')}]`
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalSerialize(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(String(value))
}

function fingerprint(kind: string, value: unknown): string {
  return `${kind}-v2-fnv1a32-${fnv1a32(canonicalSerialize(value))}`
}

function isPrefix(prefix: readonly string[], value: readonly string[]): boolean {
  return prefix.length <= value.length && prefix.every((item, index) => item === value[index])
}

function toolChoiceFingerprint(toolChoice: ModelToolChoice | undefined): string {
  return fingerprint('tool-choice', toolChoice ?? 'provider-default')
}

function profileId(input: ObserveContextCacheInput, args: {
  laneScopeFingerprint: string
  toolSetFingerprint: string
  systemFingerprint: string
}): string {
  const idFingerprint = fingerprint('profile', {
    lane: input.lane,
    laneScopeFingerprint: args.laneScopeFingerprint,
    vendor: input.vendor,
    model: input.model,
    protocolVersion: CONTEXT_CACHE_PROTOCOL_VERSION,
    toolSetFingerprint: args.toolSetFingerprint,
    toolChoiceFingerprint: toolChoiceFingerprint(input.toolChoice),
    thinking: input.thinking ?? 'provider-default',
    reasoningEffort: input.reasoningEffort ?? 'provider-default',
    systemFingerprint: args.systemFingerprint,
    requestMode: input.requestMode ?? 'default',
  })
  return `${input.lane}:${input.vendor}:${input.model}:${idFingerprint}`
}

/**
 * 跟踪每个请求 lane 的真实前缀边界。
 *
 * Provider 仍收到完整请求，并按它自己的隐式 Context Caching 规则命中；这里不发送或伪造
 * cache_id。tracker 只比较实际发送投影的指纹，生成 lane 内单调 epoch，供 UI/trace 解释
 * “为什么这一轮与上一轮不再属于同一稳定前缀”。原始 prompt、system、scope 都不会被返回。
 */
export function createContextCacheTracker(): ContextCacheTracker {
  const states = new Map<string, LaneState>()

  return {
    observe(input): ContextCacheProfile {
      const laneScopeFingerprint = fingerprint('scope', input.scope)
      const stateKey = `${input.lane}:${laneScopeFingerprint}`
      const toolSetFingerprint = toolSetSchemaFingerprint(input.tools)
      const systemFingerprint = fingerprint('system', input.systemContent)
      const projectionItemFingerprints = input.messages.map((message) =>
        fingerprint('message', message),
      )
      const requestProjectionFingerprint = fingerprint(
        'request',
        projectionItemFingerprints,
      )
      const dynamicControls = input.dynamicControls ?? []
      const dynamicControlFingerprint = fingerprint('dynamic-controls', dynamicControls)
      const dynamicTailCount = dynamicControls.length
      const nextProfileId = profileId(input, {
        laneScopeFingerprint,
        toolSetFingerprint,
        systemFingerprint,
      })
      const previous = states.get(stateKey)

      let epoch = previous?.epoch ?? 1
      let epochReason: ContextCacheEpochReason = previous?.epochReason ?? 'initial'

      if (previous) {
        if (previous.profileId !== nextProfileId) {
          epoch += 1
          epochReason = 'profile_changed'
        } else if (!isPrefix(previous.projectionItemFingerprints, projectionItemFingerprints)) {
          const previousFactProjection = previous.dynamicTailCount > 0
            ? previous.projectionItemFingerprints.slice(0, -previous.dynamicTailCount)
            : previous.projectionItemFingerprints
          const nextFactProjection = dynamicTailCount > 0
            ? projectionItemFingerprints.slice(0, -dynamicTailCount)
            : projectionItemFingerprints

          epoch += 1
          if (previous.compacted || input.compacted) {
            epochReason = 'compaction_projection_changed'
          } else if (previous.dynamicControlFingerprint !== dynamicControlFingerprint) {
            epochReason = 'dynamic_control_changed'
          } else if (
            previous.dynamicTailCount > 0
            && isPrefix(previousFactProjection, nextFactProjection)
            && nextFactProjection.length > previousFactProjection.length
          ) {
            epochReason = 'history_inserted_before_dynamic_tail'
          } else {
            epochReason = 'request_projection_changed'
          }
        }
      }

      states.set(stateKey, {
        epoch,
        epochReason,
        profileId: nextProfileId,
        projectionItemFingerprints,
        compacted: input.compacted,
        dynamicControlFingerprint,
        dynamicTailCount,
      })

      return {
        lane: input.lane,
        laneScopeFingerprint,
        profileId: nextProfileId,
        epoch,
        epochReason,
        protocolVersion: CONTEXT_CACHE_PROTOCOL_VERSION,
        toolSetFingerprint,
        systemFingerprint,
        requestProjectionFingerprint,
        compactionBoundary: input.compacted ? 'compacted-history' : 'full-history',
      }
    },
  }
}
