import {
  DEEPSEEK_FLASH_MODEL,
  DEEPSEEK_PRO_MODEL,
  DEEPSEEK_VENDOR_ID,
  DEFAULT_GLM_MODEL,
  DEFAULT_KIMI_MODEL,
  GLM_VENDOR_ID,
  KIMI_VENDOR_ID,
  OPENAI_COMPAT_VENDOR_ID,
  vendorDescriptorFor,
} from '@einfach-agent/ai'
import type { ModelSettings } from '@einfach-agent/core'
import { describe, expect, it } from 'vitest'
import { defaultSubagentTierRouting, UNROUTED_TIER_ROUTING } from './defaultTierRouting'
import { DEFAULT_TIER_ROUTING_TABLES } from './defaultTierRoutingTable'
import { createDelegateAgentRuntime } from './runtime'

/**
 * 会话是否落在档位表覆盖范围内，可观测的判据只有一个：`runLowCostExtraction` 挂没挂上
 * （core 的 `delegationRuntime.ts` 用 `supportsSubagentTierRouting` 决定挂载）。挂上 = 这个会话
 * 同时拿到了 Flash 档与低价抽取，正是本卡要给 GLM/Kimi 的东西。
 */
async function hasLowCostExtraction(settings: ModelSettings): Promise<boolean> {
  const runtime = createDelegateAgentRuntime({
    sessionId: 'session-tier',
    runId: 'run-tier',
    settings,
    apiKey: 'test-key',
    signal: new AbortController().signal,
  })
  try {
    return typeof runtime.runLowCostExtraction === 'function'
  } finally {
    await runtime.dispose?.()
  }
}

describe('defaultSubagentTierRouting', () => {
  it('keeps the DeepSeek table byte-for-byte identical to the pre-split default', () => {
    expect(defaultSubagentTierRouting(DEEPSEEK_VENDOR_ID)).toEqual({
      vendor: 'deepseek',
      models: { pro: DEEPSEEK_PRO_MODEL, flash: DEEPSEEK_FLASH_MODEL },
    })
  })

  it('serves a GLM session its own table', () => {
    expect(defaultSubagentTierRouting(GLM_VENDOR_ID)).toEqual({
      vendor: 'glm',
      models: { pro: DEFAULT_GLM_MODEL, flash: 'glm-5-turbo' },
    })
  })

  it('serves a Kimi session its own table, both tiers on the single SKU', () => {
    expect(defaultSubagentTierRouting(KIMI_VENDOR_ID)).toEqual({
      vendor: 'kimi',
      models: { pro: DEFAULT_KIMI_MODEL, flash: DEFAULT_KIMI_MODEL },
    })
  })

  it('leaves openai-compat and any unknown vendor without a lineup', () => {
    expect(defaultSubagentTierRouting(OPENAI_COMPAT_VENDOR_ID)).toBe(UNROUTED_TIER_ROUTING)
    expect(defaultSubagentTierRouting('some-private-gateway')).toBe(UNROUTED_TIER_ROUTING)
  })

  it('gives the no-lineup table a vendor id no session can ever match', () => {
    // 它必须匹配不上任何会话，否则「不覆盖」会变成「覆盖但 SKU 对不上」，两者的 route_reason
    // 不同（unrouted_provider vs custom_model）。
    expect(DEFAULT_TIER_ROUTING_TABLES.has(UNROUTED_TIER_ROUTING.vendor)).toBe(false)
    for (const vendorId of [
      DEEPSEEK_VENDOR_ID,
      GLM_VENDOR_ID,
      KIMI_VENDOR_ID,
      OPENAI_COMPAT_VENDOR_ID,
    ]) {
      expect(UNROUTED_TIER_ROUTING.vendor).not.toBe(vendorId)
    }
  })

  it('picks the table by exact vendor id, without case folding', () => {
    expect(defaultSubagentTierRouting('DeepSeek')).toBe(UNROUTED_TIER_ROUTING)
  })
})

describe('DEFAULT_TIER_ROUTING_TABLES', () => {
  it('lists only models the vendor capability table knows', () => {
    for (const [vendorId, routing] of DEFAULT_TIER_ROUTING_TABLES) {
      expect(routing.vendor).toBe(vendorId)
      const known = vendorDescriptorFor(vendorId).models
      for (const model of Object.values(routing.models)) {
        expect(Object.keys(known)).toContain(model)
      }
    }
  })
})

describe('tier routing coverage seen from a delegate runtime', () => {
  it('covers a DeepSeek, GLM and Kimi session on their tier SKUs', async () => {
    expect(await hasLowCostExtraction({ vendor: 'deepseek', model: DEEPSEEK_PRO_MODEL })).toBe(true)
    expect(await hasLowCostExtraction({ vendor: 'glm', model: DEFAULT_GLM_MODEL })).toBe(true)
    expect(await hasLowCostExtraction({ vendor: 'glm', model: 'glm-5-turbo' })).toBe(true)
    expect(await hasLowCostExtraction({ vendor: 'kimi', model: DEFAULT_KIMI_MODEL })).toBe(true)
  })

  it('leaves private gateways and off-table models uncovered', async () => {
    expect(await hasLowCostExtraction({
      vendor: 'openai-compat',
      model: 'whatever-the-gateway-serves',
    })).toBe(false)
    // 同一家 vendor、表外的模型名：档位表在，但不假定这个模型实现了同样的档位。
    expect(await hasLowCostExtraction({ vendor: 'glm', model: 'glm-4.5-flash' })).toBe(false)
  })

  it('sends a GLM extraction to the GLM flash SKU without retaining unsupported effort', async () => {
    // GLM Turbo 是 toggle-only：低价抽取明确关闭 thinking，不能把会话的 high effort
    // 残留到请求里。
    const bodies: string[] = []
    const runtime = createDelegateAgentRuntime({
      sessionId: 'session-glm',
      runId: 'run-glm',
      settings: {
        vendor: 'glm',
        model: DEFAULT_GLM_MODEL,
        thinking: true,
        vendorSettings: { reasoning_effort: 'high' },
      },
      apiKey: 'test-key',
      signal: new AbortController().signal,
      fetchImpl: async (_input, init) => {
        bodies.push(String(init?.body ?? ''))
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '抽取结果' }, finish_reason: 'stop' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      },
    })

    try {
      const result = await runtime.runLowCostExtraction!({
        systemPrompt: '抽取要点',
        userPrompt: '一段很长的原文',
      })
      expect(result.model).toBe('glm-5-turbo')
    } finally {
      await runtime.dispose?.()
    }

    expect(bodies).toHaveLength(1)
    const request = JSON.parse(bodies[0]!) as Record<string, unknown>
    expect(request.model).toBe('glm-5-turbo')
    expect(request).not.toHaveProperty('reasoning_effort')
  })
})
