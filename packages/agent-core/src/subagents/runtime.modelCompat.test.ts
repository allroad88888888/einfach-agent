import { describe, expect, it } from 'vitest'
import { createDelegateAgentRuntime } from '@web-agent/subagents'
import {
  context,
  messagesOf,
  requestBody,
  response,
  runtime,
} from './runtime.testHarness'

describe('createDelegateAgentRuntime · 主 Agent 模型兼容迁移（发请求前）', () => {
  it('父会话带 deepseek-reasoner → 迁移后默认子 agent 请求体按路由使用 v4-pro 且 thinking enabled', async () => {
    // 子 agent 复用父会话 settings。父会话若带着已下线的模型名，扇出的每个子 agent 都会撞 400。
    // createDelegateAgentRuntime 在入口整体迁移并收口主模型；未显式选择 Flash 的子任务默认使用 Pro。
    let childBody: Record<string, unknown> = {}
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      childBody = body
      return response({ content: 'done' })
    }
    const delegateRuntime = createDelegateAgentRuntime({
      sessionId: 'session',
      runId: 'run-mig',
      settings: { vendor: 'deepseek', model: 'deepseek-reasoner' },
      apiKey: 'test-key',
      signal: new AbortController().signal,
      fetchImpl,
    })

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'go' }], toolProfile: 'workspace_read' },
      context(new Map()),
    )
    expect(result.children[0].status).toBe('done')
    expect(childBody.model).toBe('deepseek-v4-pro')
    expect(childBody.thinking).toEqual({ type: 'enabled' })
    delegateRuntime.dispose?.()
  })
})

describe('createDelegateAgentRuntime · runLowCostExtraction', () => {
  // 回归护栏：曾经给内部 callModel 传死 maxModelCalls=1，而那个参数是「树累计上限」而非
  // 「本次花几次」。于是只要本 run 里跑过任何子 agent（含上一个 stage 的 evaluator），
  // modelCallsUsed 就已 ≥ 1，这里必抛 budget exhausted —— 调用方 best-effort 吞掉异常，
  // 能力从第二个 stage 起静默失效，且因为工具侧全 mock，测试还全绿。
  it('子 agent 跑过之后仍然可用，并且可以连续调用', async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      return body.tool_choice === 'none' && body.model === 'deepseek-v4-flash'
        ? response({ role: 'assistant', content: '{"commands":[],"warnings":[]}' })
        : response({ role: 'assistant', content: 'done' })
    }
    const delegateRuntime = runtime(fetchImpl)

    await delegateRuntime.delegateAgents(
      { children: [{ objective: 'inspect one bounded item' }] },
      context(new Map()),
    )
    const first = await delegateRuntime.runLowCostExtraction!({ systemPrompt: 'sys', userPrompt: 'user' })
    const second = await delegateRuntime.runLowCostExtraction!({ systemPrompt: 'sys', userPrompt: 'user' })

    expect(first.model).toBe('deepseek-v4-flash')
    expect(second.model).toBe('deepseek-v4-flash')
    delegateRuntime.dispose?.()
  })

  it('走的是 flash 档、无工具、temperature 0、thinking 关闭', async () => {
    let extractionBody: Record<string, unknown> = {}
    const fetchImpl: typeof fetch = async (_url, init) => {
      extractionBody = requestBody(init)
      return response({ role: 'assistant', content: '{}' })
    }
    const delegateRuntime = runtime(fetchImpl)

    await delegateRuntime.runLowCostExtraction!({
      systemPrompt: 'sys',
      userPrompt: 'user',
      maxOutputTokens: 1_200,
    })

    expect(extractionBody.model).toBe('deepseek-v4-flash')
    expect(extractionBody.temperature).toBe(0)
    expect(extractionBody.thinking).toEqual({ type: 'disabled' })
    expect(extractionBody.tool_choice).toBe('none')
    expect(messagesOf(extractionBody).map((message) => message.role)).toEqual(['system', 'user'])
    delegateRuntime.dispose?.()
  })

  // 供应商支持与否在构造时就确定，故做成「方法在不在」而不是「调用时抛」：
  // 后者会让宿主的能力探测恒真，把永久性不可用伪装成可重试的运行时失败。
  it('非 DeepSeek 双档模型时，整个方法不挂载', async () => {
    const fetchImpl: typeof fetch = async () => response({ role: 'assistant', content: 'done' })
    const glm = createDelegateAgentRuntime({
      sessionId: 'session',
      runId: 'run-glm',
      settings: { vendor: 'glm', model: 'glm-4.6' },
      apiKey: 'test-key',
      signal: new AbortController().signal,
      fetchImpl,
    })
    expect(glm.runLowCostExtraction).toBeUndefined()
    glm.dispose?.()
  })
})
