// applyWorkspacePatch 的 invokeDispatchMs 计时语义（D5）。
// 这条诊断度量的是「IPC 派发有多慢」；@tauri-apps/api/core 的首次惰性加载有几 ms 开销，
// 必须在 dispatchStartedAt 采样之前完成，否则首次调用会把模块加载耗时伪装成 IPC 派发慢。
import { describe, expect, it, vi } from 'vitest'

// clock 是虚拟时钟：只有 loadHostInvoke 推进它，invoke 派发本身零成本。
// 用真实墙钟做阈值断言在并行负载下会抖，虚拟时钟让「加载耗时是否落进计时窗口」变成确定性事实。
const host = vi.hoisted(() => ({ loadCostMs: 0, invoke: vi.fn() }))
const clock = vi.hoisted(() => ({ now: 0 }))

vi.mock('./hostBridge', () => ({
  hasHostBridge: () => true,
  loadHostInvoke: async () => {
    clock.now += host.loadCostMs
    await Promise.resolve() // import() 是异步的，保留一次微任务跨越
    return host.invoke
  },
}))

import { applyWorkspacePatch } from './workspacePatch'
import type { ObservabilityPort } from '../observability/port'

const LOAD_COST_MS = 20

function stubObservability(samples: number[], onFinish: (attrs?: Record<string, unknown>) => void) {
  return {
    performanceNow: () => {
      samples.push(clock.now)
      return clock.now
    },
    beginPerformanceDiagnostic: () => ({
      operationId: 'op-timing',
      finish: (_status?: string, attrs?: Record<string, unknown>) => {
        onFinish(attrs)
        return 0
      },
    }),
  } as unknown as ObservabilityPort
}

describe('applyWorkspacePatch 的 invokeDispatchMs 计时语义', () => {
  it('惰性加载 @tauri-apps/api/core 的耗时发生在计时起点之前，不计入 invokeDispatchMs', async () => {
    host.loadCostMs = LOAD_COST_MS
    clock.now = 0
    const samples: number[] = []
    let finishAttrs: Record<string, unknown> | undefined
    host.invoke.mockResolvedValue({ ok: true, changed_files: ['a.txt'], rejected: [] })

    const result = await applyWorkspacePatch(
      { operations: [{ type: 'add_file', path: 'a.txt', content: 'x' }] },
      stubObservability(samples, (attrs) => {
        finishAttrs = attrs
      }),
    )

    expect(result.ok).toBe(true)
    // samples[0] 就是 dispatchStartedAt：计时窗口打开时加载代价已经全额记在时钟上，
    // 证明 loadHostInvoke 落在采样之前。若把加载挪进 try 里，这里会变成 0、下面会变成 20。
    expect(samples[0]).toBe(LOAD_COST_MS)
    expect(finishAttrs?.invokeDispatchMs).toBe(0)
    expect(finishAttrs?.invokeDispatchMs as number).toBeLessThan(LOAD_COST_MS)
  })
})
