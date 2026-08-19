import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostBridgeMock } from './hostBridgeMock.testHarness'

// 宿主 invoke 的替身：被下面的 './hostBridge' 桥 mock 直接引用，也被本文件的断言直接检查。
const host = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

// H3：workspaceWrite 改用 ./hostBridge 之后，宿主判定读的是 hasHostBridge()、invoke 走惰性
// loadHostInvoke()，两者都不再经过上面那个替身。这里把 hostBridge 一并 mock 掉：hasHostBridge
// 恒真、loadHostInvoke 仍然吐同一个 host.invoke，既有用例的断言一字不动照旧成立。
// clock 是计时用例的虚拟时钟——只有 loadHostInvoke 会推进它，用真实墙钟做阈值断言在并行负载下会抖。
const loadTiming = vi.hoisted(() => ({ loadCostMs: 0 }))
const clock = vi.hoisted(() => ({ now: 0 }))

vi.mock('./hostBridge', () => hostBridgeMock(async () => {
  clock.now += loadTiming.loadCostMs
  await Promise.resolve() // import() 是异步的，保留一次微任务跨越
  return host.invoke
}))

import { writeWorkspaceFile } from './workspaceWrite'
import type { ObservabilityPort } from '../observability/port'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('writeWorkspaceFile', () => {
  it('把 expectedContentHash 映射为 Tauri snake_case 参数', async () => {
    const expectedContentHash = `sha256:${'a'.repeat(64)}`
    host.invoke.mockResolvedValue({
      ok: true,
      path: 'a.txt',
      bytes_written: 3,
      created: false,
      overwritten: true,
      appended: false,
    })

    await expect(
      writeWorkspaceFile({
        path: 'a.txt',
        content: 'new',
        mode: 'overwrite',
        expectedContentHash,
      }),
    ).resolves.toMatchObject({ ok: true, overwritten: true })

    expect(host.invoke).toHaveBeenCalledWith(
      'write_workspace_file',
      expect.objectContaining({
        path: 'a.txt',
        content: 'new',
        mode: 'overwrite',
        expected_content_hash: expectedContentHash,
      }),
    )
  })
})

const LOAD_COST_MS = 20

describe('writeWorkspaceFile 的 invokeDispatchMs 计时语义', () => {
  afterEach(() => {
    loadTiming.loadCostMs = 0
  })

  it('惰性解析宿主 invoke 的耗时发生在计时起点之前，不计入 invokeDispatchMs', async () => {
    loadTiming.loadCostMs = LOAD_COST_MS
    clock.now = 0
    const samples: number[] = []
    let finishAttrs: Record<string, unknown> | undefined
    const observability = {
      // 时钟只被 loadHostInvoke 推进：invoke 派发本身零成本，dispatch 计时窗口里没有任何时间流逝。
      performanceNow: () => {
        samples.push(clock.now)
        return clock.now
      },
      beginPerformanceDiagnostic: () => ({
        operationId: 'op-timing',
        finish: (_status?: string, attrs?: Record<string, unknown>) => {
          finishAttrs = attrs
          return 0
        },
      }),
    } as unknown as ObservabilityPort
    host.invoke.mockResolvedValue({ ok: true, path: 'a.txt', bytes_written: 1, created: true })

    await writeWorkspaceFile({ path: 'a.txt', content: 'x' }, observability)

    // samples[0] 就是 dispatchStartedAt：计时窗口打开时加载代价已经全额记在时钟上，
    // 证明 loadHostInvoke 落在采样之前。若把加载挪进 try 里，这里会变成 0、下面会变成 20。
    expect(samples[0]).toBe(LOAD_COST_MS)
    expect(finishAttrs?.invokeDispatchMs).toBe(0)
    expect(finishAttrs?.invokeDispatchMs as number).toBeLessThan(LOAD_COST_MS)
  })
})
