// 拆分自 modelRun.test.ts（T1）。原文件同名 describe 段落逐字迁移。

import { describe, it, expect, afterEach } from 'vitest'
import { sessionsAtom } from '../state/rootStore'
import type { ModelSettings } from '../state/core.type'
import { runSession } from './modelRun'
import { resetModelRunTestState, seedSession, jsonResponse } from './modelRun.testHarness'

afterEach(() => {
  resetModelRunTestState()
})

  // 请求路径兜底：seedSession 直接写 sessionsAtom、【不经 hydrate】—— 正是「绕过 hydrate 迁移」
  // 的场景。会话带着已下线的 deepseek-chat / deepseek-reasoner，发出去的主 Agent 请求必须
  // 迁移到 Flash，且 deepseek-reasoner 要连带把 thinking 补成 enabled（旧名隐含思考模式）。
  describe('主 Agent 模型在发请求前归一化（hydrate 之外的最后一道防线）', () => {
    async function capturedRequestFor(settings: ModelSettings): Promise<Record<string, unknown>> {
      seedSession('mig1', settings)
      let captured: Record<string, unknown> = {}
      const fetchImpl: typeof fetch = (_url, init) => {
        captured = JSON.parse(init!.body as string)
        return Promise.resolve(jsonResponse('ok'))
      }
      await runSession('mig1', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })
      return captured
    }

    it('deepseek-chat → v4-flash 且 thinking 显式 disabled（保留旧非思考行为）', async () => {
      const body = await capturedRequestFor({ vendor: 'deepseek', model: 'deepseek-chat' })
      expect(body.model).toBe('deepseek-v4-flash')
      // 旧 deepseek-chat = 非思考模式；迁移后仍保留旧名隐含的模式语义。
      expect(body.thinking).toEqual({ type: 'disabled' })
    })

    it('deepseek-reasoner → v4-flash 且 thinking 补成 enabled（旧名隐含思考模式）', async () => {
      const body = await capturedRequestFor({ vendor: 'deepseek', model: 'deepseek-reasoner' })
      expect(body.model).toBe('deepseek-v4-flash')
      expect(body.thinking).toEqual({ type: 'enabled' })
    })

    it('用户显式关了 thinking → 迁移不覆盖他的选择（thinking 优先于旧名隐含语义）', async () => {
      const body = await capturedRequestFor({
        vendor: 'deepseek',
        model: 'deepseek-reasoner',
        thinking: false,
      })
      expect(body.model).toBe('deepseek-v4-flash')
      expect(body.thinking).toEqual({ type: 'disabled' })
    })

    it.each(['deepseek-v4-flash', 'deepseek-v4-pro'])(
      '未下线的模型名 %s 原样发出（不覆盖用户已保存的选择）',
      async (model) => {
        const body = await capturedRequestFor({ vendor: 'deepseek', model })
        expect(body.model).toBe(model)
      },
    )
  })
