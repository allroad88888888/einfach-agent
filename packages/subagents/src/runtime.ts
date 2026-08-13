import {
  createDelegationRuntime,
  formatSubagentTranscript,
  type DelegationRuntime,
  type DelegationRuntimeInput,
  type DelegationRuntimePorts,
  type SubagentScheduler,
  type SubagentTierRouting,
} from '@web-agent/core/subagents'
import { recordCompletedSpan } from '@web-agent/core/observability'
import type { ModelSettings } from '@web-agent/core/state/core.type'
import { SubagentArchiveIO } from './archive/archiveIO'
import type { SubagentArchiveWriterContext } from './archive/archiveWriter'
import { distillDelegateSkills } from './archive/distill'
import {
  subagentCacheBasePath,
  subagentEventsPath,
  subagentResultPath,
} from './archive/skillCache'
import { DEFAULT_SUBAGENT_TIER_ROUTING } from './defaultTierRouting'
import { createSubagentScheduler } from './schedulerState'

export type CreateDelegateAgentRuntimeOptions = DelegationRuntimeInput & {
  /** Standalone callers receive an isolated scheduler; assemblies pass their shared one. */
  scheduler?: SubagentScheduler
  /** Overrides the shipped default Pro/Flash routing table (tests only; hosts get the default). */
  tierRouting?: SubagentTierRouting
}

function archiveWriterContext(core: object | undefined): SubagentArchiveWriterContext {
  return { queueKey: core ?? {}, traceRecorder: { recordCompletedSpan } }
}

// 低价抽取请求：固定 temperature 0、关闭 thinking，只换模型。Kimi 的会话类型不携带
// temperature/max_tokens（K2.6 用固定采样参数，core 故意不透传），先按 vendor 分支排除它，
// 再展开 `primary`——展开一个已经窄化到具体成员的 ModelSettings 才会按该成员的字段集合
// 类型检查；直接拼一个 `{ vendor: 联合类型, ... }` 字面量不会窄化到任何一个具体成员。
function lowCostExtractionSettings(primary: ModelSettings, model: string, maxTokens: number): ModelSettings {
  if (primary.vendor === 'kimi') return { ...primary, model, thinking: false }
  return { ...primary, model, temperature: 0, thinking: false, max_tokens: maxTokens }
}

/** 把本包的调度、归档、蒸馏与厂商判断装成 core 委派运行时所需的六个端口。 */
function delegationRuntimePorts(opts: CreateDelegateAgentRuntimeOptions): DelegationRuntimePorts {
  return {
    scheduler: opts.scheduler ?? createSubagentScheduler(),
    tierRouting: opts.tierRouting ?? DEFAULT_SUBAGENT_TIER_ROUTING,
    archive: new SubagentArchiveIO({
      writerContext: archiveWriterContext(opts.core),
      sessionId: opts.sessionId,
      runId: opts.runId,
      model: opts.settings.model,
      vendor: opts.settings.vendor,
      onTraceItem: opts.onTraceItem,
    }),
    archiveFormat: {
      cacheBasePath: subagentCacheBasePath,
      eventsPath: subagentEventsPath,
      resultPath: subagentResultPath,
      formatParentTranscript: formatSubagentTranscript,
    },
    skillDistill: { distill: distillDelegateSkills },
    lowCostExtractionSettings,
  }
}

/**
 * Creates the public delegate-agent runtime from this package's ports.
 *
 * 执行装配（内核容器、子 run 调用帧、批次入口与生命周期）已下沉 core 的
 * `createDelegationRuntime`；本函数只剩端口装配，保留原有工厂名与签名给既有调用方。
 */
export function createDelegateAgentRuntime(
  rawOpts: CreateDelegateAgentRuntimeOptions,
): DelegationRuntime {
  return createDelegationRuntime(rawOpts, delegationRuntimePorts(rawOpts))
}
