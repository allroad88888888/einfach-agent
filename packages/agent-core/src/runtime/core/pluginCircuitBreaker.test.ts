// wrapDynamicPluginActivate 的单元覆盖：直接经 assemblePlugins 组装，验证熔断计数、
// 归因 trace 属性与「重新安装即重新计数」——不依赖 pluginHost，行为由 pluginHost.test.ts
// 的集成用例再验证一遍真实接线（工具卸载、构造期插件不受影响）。

import { describe, expect, it, vi } from 'vitest'
import type { CoreCtx } from './coreCtx'
import { assemblePlugins } from './pluginApi'
import type { PluginApi } from './pluginApi'
import { PLUGIN_HOOK_FAILURE_THRESHOLD, wrapDynamicPluginActivate } from './pluginCircuitBreaker'

function makeCtx(traceEvent = vi.fn()): CoreCtx {
  return { sessionId: 's', runId: 'r', traceEvent } as unknown as CoreCtx
}

const ev = { callId: 'c1', toolName: 'demo', args: {} }
const identity = { id: 'acme.demo', version: '1.0.0' }

function alwaysFailingActivate(): (api: PluginApi) => void {
  return (api) => {
    api.hook('beforeToolCall', () => {
      throw new Error('boom')
    })
  }
}

describe('wrapDynamicPluginActivate —— 连续失败熔断（P7）', () => {
  it('连续 3 次 hook 失败即自动停用，并发一条带 plugin.id/version 的 trace event', async () => {
    const onAutoDisable = vi.fn()
    const traceEvent = vi.fn()
    const wrapped = wrapDynamicPluginActivate(alwaysFailingActivate(), identity, onAutoDisable)
    const hooks = assemblePlugins([wrapped])
    const ctx = makeCtx(traceEvent)

    for (let i = 0; i < PLUGIN_HOOK_FAILURE_THRESHOLD; i += 1) {
      await expect(hooks.beforeToolCall?.(ctx, ev)).rejects.toThrow('boom')
    }

    expect(onAutoDisable).toHaveBeenCalledTimes(1)
    const failedEvents = traceEvent.mock.calls.filter(([name]) => name === 'agent.plugin_hook_failed')
    expect(failedEvents).toHaveLength(PLUGIN_HOOK_FAILURE_THRESHOLD)
    expect(failedEvents[0]?.[1]).toMatchObject({
      'plugin.id': 'acme.demo',
      'plugin.version': '1.0.0',
      hook: 'beforeToolCall',
      consecutiveFailures: 1,
      error: 'boom',
    })

    const disabledEvents = traceEvent.mock.calls.filter(([name]) => name === 'agent.plugin_auto_disabled')
    expect(disabledEvents).toHaveLength(1)
    expect(disabledEvents[0]?.[1]).toMatchObject({
      'plugin.id': 'acme.demo',
      'plugin.version': '1.0.0',
      consecutiveFailures: PLUGIN_HOOK_FAILURE_THRESHOLD,
    })
    expect(String(disabledEvents[0]?.[1]?.reason)).toContain('已自动停用')
  })

  it('未达阈值前每次失败仍原样 rethrow，且不触发停用', async () => {
    const onAutoDisable = vi.fn()
    const wrapped = wrapDynamicPluginActivate(alwaysFailingActivate(), identity, onAutoDisable)
    const hooks = assemblePlugins([wrapped])
    const ctx = makeCtx()

    await expect(hooks.beforeToolCall?.(ctx, ev)).rejects.toThrow('boom')
    await expect(hooks.beforeToolCall?.(ctx, ev)).rejects.toThrow('boom')

    expect(onAutoDisable).not.toHaveBeenCalled()
  })

  it('任一次成功即把连续失败计数归零', async () => {
    const onAutoDisable = vi.fn()
    let shouldFail = true
    const wrapped = wrapDynamicPluginActivate(
      (api) => {
        api.hook('beforeToolCall', () => {
          if (shouldFail) throw new Error('boom')
          return undefined
        })
      },
      identity,
      onAutoDisable,
    )
    const hooks = assemblePlugins([wrapped])
    const ctx = makeCtx()

    await expect(hooks.beforeToolCall?.(ctx, ev)).rejects.toThrow('boom')
    await expect(hooks.beforeToolCall?.(ctx, ev)).rejects.toThrow('boom')
    shouldFail = false
    await expect(hooks.beforeToolCall?.(ctx, ev)).resolves.toBeUndefined()
    shouldFail = true
    await expect(hooks.beforeToolCall?.(ctx, ev)).rejects.toThrow('boom')
    await expect(hooks.beforeToolCall?.(ctx, ev)).rejects.toThrow('boom')

    // 中间的一次成功把计数清零；这里只又攒了 2 次失败，未达阈值 3。
    expect(onAutoDisable).not.toHaveBeenCalled()
  })

  it('重新调用 wrapDynamicPluginActivate（对应手动重新 installPlugin）得到全新计数器', async () => {
    const onAutoDisableFirst = vi.fn()
    const first = wrapDynamicPluginActivate(alwaysFailingActivate(), identity, onAutoDisableFirst)
    const firstHooks = assemblePlugins([first])
    const ctx = makeCtx()
    for (let i = 0; i < PLUGIN_HOOK_FAILURE_THRESHOLD; i += 1) {
      await expect(firstHooks.beforeToolCall?.(ctx, ev)).rejects.toThrow('boom')
    }
    expect(onAutoDisableFirst).toHaveBeenCalledTimes(1)

    // 手动恢复：重新包装同一 identity——不是同一个计数器，旧的失败次数不会带过来。
    const onAutoDisableSecond = vi.fn()
    const second = wrapDynamicPluginActivate(alwaysFailingActivate(), identity, onAutoDisableSecond)
    const secondHooks = assemblePlugins([second])
    await expect(secondHooks.beforeToolCall?.(ctx, ev)).rejects.toThrow('boom')
    await expect(secondHooks.beforeToolCall?.(ctx, ev)).rejects.toThrow('boom')

    expect(onAutoDisableSecond).not.toHaveBeenCalled()
  })

  it('停用后不重复触发 onAutoDisable，即使同一 run 内该 hook 继续被调用失败', async () => {
    const onAutoDisable = vi.fn()
    const wrapped = wrapDynamicPluginActivate(alwaysFailingActivate(), identity, onAutoDisable)
    const hooks = assemblePlugins([wrapped])
    const ctx = makeCtx()

    for (let i = 0; i < PLUGIN_HOOK_FAILURE_THRESHOLD + 2; i += 1) {
      await expect(hooks.beforeToolCall?.(ctx, ev)).rejects.toThrow('boom')
    }

    expect(onAutoDisable).toHaveBeenCalledTimes(1)
  })
})
