import { firstAssistantText } from '@web-agent/ai'
import {
  formatSubagentTranscript,
  subagentTierTarget,
  supportsSubagentTierRouting,
  type DelegationRuntime,
  type DelegationRuntimeInput,
  type SubagentScheduler,
  type SubagentTierRouting,
} from '@web-agent/core/subagents'
import { recordCompletedSpan } from '@web-agent/core/observability'
import { createChildModelCaller } from '@web-agent/core/subagents/childModelClient'
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
import { DelegateAgentRuntimeState } from '@web-agent/core/subagents/runtimeState'
// S11d 批次执行段已下沉 core（packages/agent-core/src/subagents/delegationBatch.ts）；
// 未进 barrel（`createDelegateAgents(runtime: DelegateAgentRuntimeState)` 的入参是内核子 run 的
// 可变资源容器，按 subagents/index.ts 的收录判据属内部），暂走深路径，见
// scripts/check-boundaries.js 豁免表 packages/subagents 那组，S11e 工厂下沉后本行消失。
import { createDelegateAgents } from '@web-agent/core/subagents/delegationBatch'
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

/** Creates the public delegate-agent runtime and owns its retain/release lifecycle. */
export function createDelegateAgentRuntime(
  rawOpts: CreateDelegateAgentRuntimeOptions,
): DelegationRuntime {
  const scheduler = rawOpts.scheduler ?? createSubagentScheduler()
  const runtime = new DelegateAgentRuntimeState({
    ...rawOpts,
    scheduler,
    tierRouting: rawOpts.tierRouting ?? DEFAULT_SUBAGENT_TIER_ROUTING,
    archive: new SubagentArchiveIO({
      writerContext: archiveWriterContext(rawOpts.core),
      sessionId: rawOpts.sessionId,
      runId: rawOpts.runId,
      model: rawOpts.settings.model,
      vendor: rawOpts.settings.vendor,
      onTraceItem: rawOpts.onTraceItem,
    }),
    archiveFormat: {
      cacheBasePath: subagentCacheBasePath,
      eventsPath: subagentEventsPath,
      resultPath: subagentResultPath,
      formatParentTranscript: formatSubagentTranscript,
    },
    skillDistill: { distill: distillDelegateSkills },
    lowCostExtractionSettings,
  })
  const callModel = createChildModelCaller(runtime)
  const delegateAgents = createDelegateAgents(runtime)

  async function runLowCostExtraction(input: {
    systemPrompt: string
    userPrompt: string
    maxOutputTokens?: number
  }): Promise<{ content: string; model: string }> {
    if (runtime.disposed) throw new Error('delegate runtime already disposed')
    const systemPrompt = input.systemPrompt.trim()
    const userPrompt = input.userPrompt.trim()
    if (!systemPrompt || !userPrompt) {
      throw new Error('low-cost extraction requires systemPrompt and userPrompt')
    }
    const requestedMaxTokens = Number.isFinite(input.maxOutputTokens)
      ? Math.floor(input.maxOutputTokens!)
      : 1_200
    // 模型来自注入的档位表而非字面量。
    const target = subagentTierTarget(runtime.tierRouting, 'flash')
    const response = await callModel(
      runtime.lowCostExtractionState ??= runtime.createDelegationCallState(),
      {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        tools: [],
        toolChoice: 'none',
        settings: lowCostExtractionSettings(
          runtime.opts.settings,
          target.model,
          Math.max(256, Math.min(requestedMaxTokens, 2_000)),
        ),
      },
    )
    const content = firstAssistantText(response)
    if (!content) throw new Error('low-cost extraction returned no text')
    return { content, model: target.model }
  }

  return {
    delegateAgents,
    ...(supportsSubagentTierRouting(runtime.opts.settings, runtime.tierRouting)
      ? { runLowCostExtraction }
      : {}),
    retain: () => runtime.retain(),
    release: () => { void runtime.releaseOwner() },
    cancel: () => runtime.runtimeController.abort(),
    dispose: () => runtime.releaseOwner(),
  }
}
