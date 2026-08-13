import { DEEPSEEK_FLASH_MODEL } from '@web-agent/ai'
import type {
  DelegationRuntime,
  DelegationRuntimeInput,
  SubagentScheduler,
} from '@web-agent/core/runtime/delegationContract'
import { recordCompletedSpan } from '@web-agent/core/observability/trace'
import {
  createChildModelCaller,
  firstAssistantText,
} from '@web-agent/core/subagents/childModelClient'
import { supportsSubagentTierRouting } from '@web-agent/core/subagents/tierRouting'
import { formatSubagentTranscript } from '@web-agent/core/runtime/subagentTranscript'
import { SubagentArchiveIO } from './archive/archiveIO'
import type { SubagentArchiveWriterContext } from './archive/archiveWriter'
import { subagentResultPath } from './archive/skillCache'
import { DelegateAgentRuntimeState } from '@web-agent/core/subagents/runtimeState'
import { createDelegateAgents } from './delegationBatch'
import { createSubagentScheduler } from './schedulerState'

export type CreateDelegateAgentRuntimeOptions = DelegationRuntimeInput & {
  /** Standalone callers receive an isolated scheduler; assemblies pass their shared one. */
  scheduler?: SubagentScheduler
}

function archiveWriterContext(core: object | undefined): SubagentArchiveWriterContext {
  return { queueKey: core ?? {}, traceRecorder: { recordCompletedSpan } }
}

/** Creates the public delegate-agent runtime and owns its retain/release lifecycle. */
export function createDelegateAgentRuntime(
  rawOpts: CreateDelegateAgentRuntimeOptions,
): DelegationRuntime {
  const scheduler = rawOpts.scheduler ?? createSubagentScheduler()
  const runtime = new DelegateAgentRuntimeState({
    ...rawOpts,
    scheduler,
    archive: new SubagentArchiveIO({
      writerContext: archiveWriterContext(rawOpts.core),
      sessionId: rawOpts.sessionId,
      runId: rawOpts.runId,
      model: rawOpts.settings.model,
      vendor: rawOpts.settings.vendor,
      onTraceItem: rawOpts.onTraceItem,
    }),
    archiveFormat: {
      resultPath: subagentResultPath,
      formatParentTranscript: formatSubagentTranscript,
    },
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
    const response = await callModel(
      runtime.lowCostExtractionState ??= runtime.createDelegationCallState(),
      {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        tools: [],
        toolChoice: 'none',
        settings: {
          vendor: 'deepseek',
          model: DEEPSEEK_FLASH_MODEL,
          temperature: 0,
          thinking: false,
          max_tokens: Math.max(256, Math.min(requestedMaxTokens, 2_000)),
          ...(runtime.opts.settings.vendor === 'deepseek'
            ? { reasoning_effort: runtime.opts.settings.reasoning_effort }
            : {}),
        },
      },
    )
    const content = firstAssistantText(response)
    if (!content) throw new Error('low-cost extraction returned no text')
    return { content, model: DEEPSEEK_FLASH_MODEL }
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
