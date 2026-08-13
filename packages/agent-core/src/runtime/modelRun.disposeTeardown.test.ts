// 拆分自 modelRun.test.ts（T1）。原文件同名 describe 段落逐字迁移。

import { describe, it, expect, afterEach } from 'vitest'
import { getSessionStore } from '../state/sessionStore'
import { runAtom, checkpointsAtom } from '../state/sessionAtoms'
import { patchRun } from '../state/sessionWriters'
import { runSession, runToolLoop } from './modelRun'
import { configureObservability, flushObservability } from '../observability/trace'
import { configureDefaultDelegation } from './core/coreInstance'
import { createTestDelegationRuntime } from '../subagents/runtime.ports.testFixtures'
import { createTestScheduler } from '../subagents/runtime.scheduler.testFixtures'
import { resetModelRunTestState, seedSession, jsonResponse, captureTrace } from './modelRun.testHarness'

// 标的是主循环 finally 里的 dispose 异常隔离，与委派实现无关：注入一个 core 侧的假委派能力，
// 需要时把它的 dispose 换成必抛的版本即可，不必去 mock 产品包的工厂。
const disposeControl = { error: undefined as Error | undefined }

afterEach(() => {
  resetModelRunTestState()
  disposeControl.error = undefined
})

function installDefaultDelegationForDisposeTest(): void {
  configureDefaultDelegation(() => {
    const scheduler = createTestScheduler()
    return {
      scheduler,
      async createRuntime(input) {
        const runtime = createTestDelegationRuntime({ ...input, scheduler })
        const failure = disposeControl.error
        if (!failure) return runtime
        return {
          ...runtime,
          dispose: async () => {
            throw failure
          },
        }
      },
    }
  })
}

// ---------------------------------------------------------------------------
// 收尾（finally）里的 delegateRuntime.dispose
// ---------------------------------------------------------------------------
describe('收尾 dispose 的异常隔离', () => {
  it('dispose 抛错：不从 runToolLoop 逃逸，run 结局与 checkpoint 都保持完好', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    // ★ 回归：finally 与外层 try/catch 是平级的 —— dispose 一抛，异常直接从 runToolLoop 逃逸，
    //   绕过刚做完的降级逻辑：run 停在最后一次 patchRun 的值上，调用方的 endRun 执行与否看天。
    disposeControl.error = new Error('dispose boom')
    installDefaultDelegationForDisposeTest()
    seedSession('dp1', { vendor: 'deepseek', model: 'x' })
    const fetchImpl: typeof fetch = async () => jsonResponse('你好')

    await expect(
      runSession('dp1', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl }),
    ).resolves.toBeUndefined()
    await flushObservability()

    const store = getSessionStore('dp1').store
    expect(store.getter(runAtom)?.status).toBe('done')
    expect(store.getter(checkpointsAtom)).toHaveLength(1)
    // 吞掉不等于假装没发生：留一条 trace。
    const disposeEvent = trace.events.find((event) => event.name === 'agent.dispose_failed')
    expect(disposeEvent).toBeDefined()
    expect(String(disposeEvent?.attrs?.error)).toContain('dispose boom')
    expect(disposeEvent?.spanId).toBeUndefined()
  })

  it('dispose 抛 AbortError：同样不逃逸，stopped 结局不被改写', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    // 走到 finally 时本轮结局早已判完（这里是 stopped）。把 dispose 的 AbortError 再抛出去，
    // 只会把一个已经收好的 run 变成 reject —— 没有任何人会再消费它。
    const abortErr = new Error('The operation was aborted.')
    abortErr.name = 'AbortError'
    disposeControl.error = abortErr
    installDefaultDelegationForDisposeTest()
    seedSession('dp2', { vendor: 'deepseek', model: 'x' })
    const fetchImpl: typeof fetch = async () => {
      throw new DOMException('aborted', 'AbortError')
    }

    await expect(
      runSession('dp2', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl }),
    ).resolves.toBeUndefined()
    await flushObservability()

    expect(getSessionStore('dp2').store.getter(runAtom)?.status).toBe('stopped')
    const disposeEvent = trace.events.find((event) => event.name === 'agent.dispose_failed')
    expect(disposeEvent?.attrs?.aborted).toBe(true)
  })
})
