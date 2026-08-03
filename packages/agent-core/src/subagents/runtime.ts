import { DEEPSEEK_FLASH_MODEL } from '@web-agent/ai'
import { createDelegateAgents } from './delegationBatch'
import { firstAssistantText, createChildModelCaller } from './childModelClient'
import { supportsDeepSeekTierRouting } from './modelSelection'
import {
  type CreateDelegateAgentRuntimeOptions,
  DelegateAgentRuntimeState,
} from './runtimeState'
import type { DelegateAgentRuntime } from './types'

export type { CreateDelegateAgentRuntimeOptions } from './runtimeState'

/** Creates the public delegate-agent runtime and owns its retain/release lifecycle. */
export function createDelegateAgentRuntime(
  rawOpts: CreateDelegateAgentRuntimeOptions,
): DelegateAgentRuntime {
  const runtime = new DelegateAgentRuntimeState(rawOpts)
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
          ...runtime.opts.settings,
          model: DEEPSEEK_FLASH_MODEL,
          temperature: 0,
          thinking: false,
          max_tokens: Math.max(256, Math.min(requestedMaxTokens, 2_000)),
        },
      },
    )
    const content = firstAssistantText(response)
    if (!content) throw new Error('low-cost extraction returned no text')
    return { content, model: DEEPSEEK_FLASH_MODEL }
  }

  return {
    delegateAgents,
    ...(supportsDeepSeekTierRouting(runtime.opts.settings) ? { runLowCostExtraction } : {}),
    retain: () => runtime.retain(),
    release: () => { void runtime.releaseOwner() },
    cancel: () => runtime.runtimeController.abort(),
    dispose: () => runtime.releaseOwner(),
  }
}
