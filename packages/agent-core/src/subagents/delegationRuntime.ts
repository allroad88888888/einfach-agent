// 委派运行时工厂：把一份 per-run 输入（`DelegationRuntimeInput`）加一组装配层端口
// （`DelegationRuntimePorts`）装成对外的 `DelegationRuntime`。
//
// 为什么这段执行装配在 core 而不在能力包：它做的三件事——构造子 run 的可变资源容器、绑定
// 子 run 的模型调用帧、拼批次执行入口——签名全部吃 `DelegateAgentRuntimeState` /
// `DelegationCallState` 这类内核结构，按 `subagents/index.ts` 的收录判据永远不进公开面；
// 留在包侧就只能靠深导入取用。下沉之后包侧只剩「构造 ports 对象」这一件事，
// 本文件的对外签名则只由委派协议词汇构成，因此可以进 barrel。

import { firstAssistantText } from '@web-agent/ai'
import type { DelegationRuntime, DelegationRuntimeInput } from '../runtime/delegationContract'
import { createChildModelCaller } from './childModelClient'
import { createDelegateAgents } from './delegationBatch'
import type { DelegationRuntimePorts } from './delegationRuntimePorts'
import { DelegateAgentRuntimeState } from './runtimeState'
import { subagentTierTarget, supportsSubagentTierRouting } from './tierRouting'

/** 低价抽取的默认输出上限与硬夹取区间；调用方给的值只在区间内生效。 */
const DEFAULT_EXTRACTION_MAX_TOKENS = 1_200
const MIN_EXTRACTION_MAX_TOKENS = 256
const MAX_EXTRACTION_MAX_TOKENS = 2_000

/**
 * 装出一个委派运行时，并持有它的 retain/release/cancel/dispose 生命周期。
 *
 * `runLowCostExtraction` 只在会话模型落在注入档位表覆盖范围内时才挂载：能力有无在构造时就
 * 确定，做成「方法在不在」而不是「调用时抛」，否则宿主的能力探测恒真，把永久性不可用伪装成
 * 可重试的运行时失败。
 */
export function createDelegationRuntime(
  input: DelegationRuntimeInput,
  ports: DelegationRuntimePorts,
): DelegationRuntime {
  const runtime = new DelegateAgentRuntimeState({ ...input, ...ports })
  const callModel = createChildModelCaller(runtime)
  const delegateAgents = createDelegateAgents(runtime)

  async function runLowCostExtraction(extraction: {
    systemPrompt: string
    userPrompt: string
    maxOutputTokens?: number
  }): Promise<{ content: string; model: string }> {
    if (runtime.disposed) throw new Error('delegate runtime already disposed')
    const systemPrompt = extraction.systemPrompt.trim()
    const userPrompt = extraction.userPrompt.trim()
    if (!systemPrompt || !userPrompt) {
      throw new Error('low-cost extraction requires systemPrompt and userPrompt')
    }
    const requestedMaxTokens = Number.isFinite(extraction.maxOutputTokens)
      ? Math.floor(extraction.maxOutputTokens!)
      : DEFAULT_EXTRACTION_MAX_TOKENS
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
        // 固定 temperature 0、关闭 thinking，只换模型——但「换档后还能带哪些采样字段」
        // 是厂商判断，由装配层端口回答，core 不写死任何一种拼法。
        settings: ports.lowCostExtractionSettings(
          runtime.opts.settings,
          target.model,
          Math.max(MIN_EXTRACTION_MAX_TOKENS, Math.min(requestedMaxTokens, MAX_EXTRACTION_MAX_TOKENS)),
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
