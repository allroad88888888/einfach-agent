import { describe, expect, it } from 'vitest'
import {
  callWithModelEscalation,
  capacityExhaustedFinishReason,
  MODEL_ESCALATION_REQUEST_FAILED,
  modelErrorWarrantsEscalation,
  modelResponseWarrantsEscalation,
} from './modelCapacityEscalation'
import type { ModelChatResponse, ModelResponseMessage } from './modelProtocol'

const CAPACITY = 'insufficient_system_resource'

function responseWith(finishReason: string | null, message: ModelResponseMessage): ModelChatResponse {
  return { choices: [{ finish_reason: finishReason, message }] }
}

describe('容量耗尽判据', () => {
  it('只认 provider 注册表自报 capacityExhausted 的 finish_reason', () => {
    expect(capacityExhaustedFinishReason(CAPACITY)).toBe(CAPACITY)
    expect(capacityExhaustedFinishReason('length')).toBeUndefined()
    expect(capacityExhaustedFinishReason('content_filter')).toBeUndefined()
    expect(capacityExhaustedFinishReason(null)).toBeUndefined()
  })

  it('容量终态且一字未出才值得换模型', () => {
    expect(modelResponseWarrantsEscalation(responseWith(CAPACITY, { content: null }))).toBe(CAPACITY)
    expect(modelResponseWarrantsEscalation(responseWith(CAPACITY, { content: '' }))).toBe(CAPACITY)
  })

  it('已有产出的容量响应不重放——正文、推理与畸形工具调用都算产出', () => {
    expect(modelResponseWarrantsEscalation(responseWith(CAPACITY, { content: '半句话' }))).toBeUndefined()
    expect(modelResponseWarrantsEscalation(responseWith(CAPACITY, { content: null, reasoning_content: '想了一半' }))).toBeUndefined()
    // 缺 function.name 的调用运行时派发不了，但它仍是模型已经产出的东西。
    expect(modelResponseWarrantsEscalation(responseWith(CAPACITY, {
      content: null,
      tool_calls: [{ id: 'x', type: 'function', function: { arguments: '{}' } }],
    }))).toBeUndefined()
  })

  it('正常终态一律不升档', () => {
    expect(modelResponseWarrantsEscalation(responseWith('stop', { content: 'ok' }))).toBeUndefined()
    expect(modelResponseWarrantsEscalation(responseWith('length', { content: null }))).toBeUndefined()
  })
})

describe('请求失败判据', () => {
  const idle = new AbortController().signal

  it('确定性 4xx 换谁都一样被拒，不升档', () => {
    for (const status of [400, 401, 402, 422]) {
      expect(modelErrorWarrantsEscalation(new Error(`Chat completion returned ${status} (client_error).`), idle)).toBe(false)
    }
  })

  it('可能换个模型就好的失败值得升档', () => {
    expect(modelErrorWarrantsEscalation(new Error('Chat completion returned 503 (server_error).'), idle)).toBe(true)
    expect(modelErrorWarrantsEscalation(new Error('Chat completion returned 429 (rate_limited).'), idle)).toBe(true)
    expect(modelErrorWarrantsEscalation(new TypeError('network down'), idle)).toBe(true)
  })

  it('中止是用户意图，不升档——signal 与 AbortError 两条都认', () => {
    const aborted = new AbortController()
    aborted.abort()
    expect(modelErrorWarrantsEscalation(new Error('Chat completion returned 503 (server_error).'), aborted.signal)).toBe(false)
    expect(modelErrorWarrantsEscalation(new DOMException('aborted', 'AbortError'), idle)).toBe(false)
  })
})

describe('一次性升档驱动', () => {
  const idle = new AbortController().signal

  it('升档后重发一次，且只重发一次——第二次仍是容量终态也不再问', async () => {
    let calls = 0
    const asked: string[] = []
    const response = await callWithModelEscalation({
      invoke: async () => { calls += 1; return responseWith(CAPACITY, { content: null }) },
      escalate: async (trigger) => { asked.push(trigger); return true },
      signal: idle,
    })

    expect(calls).toBe(2)
    expect(asked).toEqual([CAPACITY])
    expect(response.choices?.[0]?.finish_reason).toBe(CAPACITY)
  })

  it('策略摇头时原样交回第一次的响应，不重发', async () => {
    let calls = 0
    const response = await callWithModelEscalation({
      invoke: async () => { calls += 1; return responseWith(CAPACITY, { content: null }) },
      escalate: async () => false,
      signal: idle,
    })

    expect(calls).toBe(1)
    expect(response.choices?.[0]?.finish_reason).toBe(CAPACITY)
  })

  it('请求失败升档时把原始错误一并交给策略；策略摇头则抛回原错误', async () => {
    const failure = new Error('Chat completion returned 503 (server_error).')
    let seen: unknown
    await expect(callWithModelEscalation({
      invoke: async () => { throw failure },
      escalate: async (trigger, error) => { seen = { trigger, error }; return false },
      signal: idle,
    })).rejects.toBe(failure)
    expect(seen).toEqual({ trigger: MODEL_ESCALATION_REQUEST_FAILED, error: failure })
  })

  it('判据不成立的错误根本不问策略', async () => {
    const deterministic = new Error('Chat completion returned 400 (client_error).')
    let asked = 0
    await expect(callWithModelEscalation({
      invoke: async () => { throw deterministic },
      escalate: async () => { asked += 1; return true },
      signal: idle,
    })).rejects.toBe(deterministic)
    expect(asked).toBe(0)
  })
})
