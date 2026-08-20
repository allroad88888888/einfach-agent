// 主 Agent 与子 Agent 的换模型升档【对拍】。
// ---------------------------------------------------------------------------
// C3 之前两条路各写一份判据：子 Agent 在 subagents/modelSelection.ts 里比对
// 'insufficient_system_resource' 字面量并自己解析 4xx 前缀，主 Agent 根本没有这一层。
// 现在两边都走 @einfach-agent/ai 的 modelCapacityEscalation，本文件逐条对拍：同一个模型往返
// 结果，主/子两条路必须给出**同一个升档判定**。判定相同、策略可以不同——主 Agent 的策略是
// 装配层的槽（RuntimeConfig.modelEscalation），不接就不升档，这一点由末尾两个端到端用例钉住。

import { afterEach, describe, expect, it } from 'vitest'
import { callWithModelEscalation, type ModelChatResponse } from '@einfach-agent/ai'
import { runSession } from './modelRun'
import { createModelEscalator } from './modelEscalation'
import { getSessionStore } from '../state/sessionStore'
import { runAtom } from '../state/sessionAtoms'
import { defaultCore } from './core/coreInstance'
import { callSelectedSubagentModel, createSubagentModelSelection } from '../subagents/modelSelection'
import { ROOT_AGENT_PATH } from '../subagents/path'
import type { SubagentTierRouting } from '../subagents/tierRouting'
import type { DelegateAgentChildSpec } from '../subagents/types'
import type { ModelSettings } from '../state/core.type'
import { jsonResponse, resetModelRunTestState, seedSession } from './modelRun.testHarness'

afterEach(() => {
  resetModelRunTestState()
})

const CAPACITY = 'insufficient_system_resource'
const TIER_ROUTING: SubagentTierRouting = {
  vendor: 'deepseek',
  models: { pro: 'tier-pro', flash: 'tier-flash' },
}
const FLASH_SETTINGS: ModelSettings = { vendor: 'deepseek', model: TIER_ROUTING.models.flash }
const LOW_RISK_RETRIEVAL: DelegateAgentChildSpec = {
  objective: 'look up one document',
  taskCategory: 'retrieval',
  riskLevel: 'low',
}

type Outcome =
  | { kind: 'response'; finishReason: string; content?: string | null; toolCalls?: boolean }
  | { kind: 'error'; message: string }

function produce(outcome: Outcome): Promise<ModelChatResponse> {
  if (outcome.kind === 'error') return Promise.reject(new Error(outcome.message))
  return Promise.resolve({
    choices: [{
      finish_reason: outcome.finishReason,
      message: {
        role: 'assistant' as const,
        content: outcome.content ?? null,
        ...(outcome.toolCalls ? { tool_calls: [{ id: 'c1', type: 'function' as const, function: { arguments: '{}' } }] } : {}),
      },
    }],
  })
}

// 子 Agent 侧的真实入口：档位 flash、未升过级、没有任何已发生的对外动作 —— 策略三条前提全开，
// 于是这一路的 true/false 完全由共用判据决定。
async function subagentEscalates(outcome: Outcome): Promise<boolean> {
  const input = {
    primarySettings: FLASH_SETTINGS,
    parentPath: ROOT_AGENT_PATH,
    spec: LOW_RISK_RETRIEVAL,
    confirmedTools: [] as readonly string[],
    tierRouting: TIER_ROUTING,
  }
  const selection = createSubagentModelSelection(input)
  expect(selection.routeDecision.tier).toBe('flash')
  let escalated = false
  await callSelectedSubagentModel({
    selection,
    input,
    signal: new AbortController().signal,
    invoke: () => produce(outcome),
    canEscalate: () => true,
    onEscalated: async () => { escalated = true },
  }).catch(() => undefined)
  return escalated
}

// 主 Agent 侧的同一个缝：modelTurnRequester 就是这样把策略槽接到共用驱动上的。
async function mainAgentEscalates(outcome: Outcome): Promise<boolean> {
  let settings = FLASH_SETTINGS
  let escalated = false
  const escalate = createModelEscalator({
    policy: { escalate: () => ({ ...settings, model: TIER_ROUTING.models.pro }) },
    settings: () => settings,
    canEscalate: () => true,
    applyEscalation: (next) => { settings = next },
    observe: (event) => { escalated ||= event.escalated },
  })
  await callWithModelEscalation({
    invoke: () => produce(outcome),
    escalate,
    signal: new AbortController().signal,
  }).catch(() => undefined)
  return escalated
}

const CASES: Array<{ name: string; outcome: Outcome; escalates: boolean }> = [
  { name: '容量耗尽且一字未出', outcome: { kind: 'response', finishReason: CAPACITY }, escalates: true },
  { name: '容量耗尽但已有正文', outcome: { kind: 'response', finishReason: CAPACITY, content: '半句话' }, escalates: false },
  { name: '容量耗尽但已有（畸形）工具调用', outcome: { kind: 'response', finishReason: CAPACITY, toolCalls: true }, escalates: false },
  { name: '正常收尾', outcome: { kind: 'response', finishReason: 'stop', content: 'ok' }, escalates: false },
  { name: '触顶截断', outcome: { kind: 'response', finishReason: 'length' }, escalates: false },
  { name: '400 参数非法', outcome: { kind: 'error', message: 'Chat completion returned 400 (client_error).' }, escalates: false },
  { name: '401 未授权', outcome: { kind: 'error', message: 'Chat completion returned 401 (client_error).' }, escalates: false },
  { name: '402 余额不足', outcome: { kind: 'error', message: 'Chat completion returned 402 (client_error).' }, escalates: false },
  { name: '422 实体不可处理', outcome: { kind: 'error', message: 'Chat completion returned 422 (client_error).' }, escalates: false },
  { name: '429 限流', outcome: { kind: 'error', message: 'Chat completion returned 429 (rate_limited).' }, escalates: true },
  { name: '503 服务端故障', outcome: { kind: 'error', message: 'Chat completion returned 503 (server_error).' }, escalates: true },
  { name: '网络失败', outcome: { kind: 'error', message: 'network down' }, escalates: true },
]

describe('主 Agent 与子 Agent 的升档判据对拍', () => {
  for (const testCase of CASES) {
    it(`${testCase.name}：两条路给出同一个判定（${testCase.escalates ? '升档' : '不升档'}）`, async () => {
      const child = await subagentEscalates(testCase.outcome)
      const main = await mainAgentEscalates(testCase.outcome)
      expect(child).toBe(testCase.escalates)
      expect(main).toBe(child)
    })
  }
})

function modelRecordingFetch(makers: Array<() => Response>): { fetchImpl: typeof fetch; models: string[] } {
  const models: string[] = []
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string }
    models.push(String(body.model))
    return makers[Math.min(models.length - 1, makers.length - 1)]()
  }
  return { fetchImpl, models }
}

describe('主 Agent 的升档策略槽', () => {
  it('不接槽（默认）时判据照跑但一律不升档：仍是既有的容量不足报错', async () => {
    seedSession('esc-off', FLASH_SETTINGS)
    const { fetchImpl, models } = modelRecordingFetch([
      () => new Response(JSON.stringify({ choices: [{ finish_reason: CAPACITY, message: { role: 'assistant', content: null } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ])

    await runSession('esc-off', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    // 两次都是 flash：第二次是 adapter 自己的**同模型**容量重试，与换模型无关。
    expect(models).toEqual([TIER_ROUTING.models.flash, TIER_ROUTING.models.flash])
    const run = getSessionStore('esc-off').store.getter(runAtom)
    expect(run?.status).toBe('error')
    expect(run?.error).toContain(CAPACITY)
  })

  it('接上槽后，同一个容量终态换模型重发一次并正常收尾', async () => {
    seedSession('esc-on', FLASH_SETTINGS)
    defaultCore.config.modelEscalation = {
      escalate: ({ settings }) => ({ ...settings, model: TIER_ROUTING.models.pro }),
    }
    const { fetchImpl, models } = modelRecordingFetch([
      () => new Response(JSON.stringify({ choices: [{ finish_reason: CAPACITY, message: { role: 'assistant', content: null } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      () => new Response(JSON.stringify({ choices: [{ finish_reason: CAPACITY, message: { role: 'assistant', content: null } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      () => jsonResponse('recovered by pro'),
    ])

    await runSession('esc-on', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    expect(models).toEqual([TIER_ROUTING.models.flash, TIER_ROUTING.models.flash, TIER_ROUTING.models.pro])
    expect(getSessionStore('esc-on').store.getter(runAtom)?.status).toBe('done')
  })

  it('跨厂商的升档一律拒绝：换 vendor 保不住会话其余参数', async () => {
    seedSession('esc-cross', FLASH_SETTINGS)
    defaultCore.config.modelEscalation = {
      escalate: () => ({ vendor: 'glm', model: 'glm-pro' }),
    }
    const { fetchImpl, models } = modelRecordingFetch([
      () => new Response(JSON.stringify({ choices: [{ finish_reason: CAPACITY, message: { role: 'assistant', content: null } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ])

    await runSession('esc-cross', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    expect(models).toEqual([TIER_ROUTING.models.flash, TIER_ROUTING.models.flash])
    expect(getSessionStore('esc-cross').store.getter(runAtom)?.status).toBe('error')
  })
})
