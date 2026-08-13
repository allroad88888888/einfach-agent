// commands.test.ts 拆分后的公共测试夹具（T3）。不含用例，只提供跨拆分文件复用的 setup。
// ---------------------------------------------------------------------------
// 【实例化 · 第 2 期】commands 经 defaultCore.abort 起停 run（不再从 ./abortRegistry 导入），
//   故 spy 到 defaultCore.abort 的实例方法验证「起/停 run」编排。vite.config 开了 restoreMocks（每个
//   用例前 restoreAllMocks），会把 spyOn 的 spy 还原成真实方法，故每个测试文件必须在自己的
//   beforeEach 里【每次重建】spy（模块级建一次会被还原掉）。mockImplementation 复刻旧的
//   abortRegistry mock（beginRun 返回一个 signal，abortRun/endRun 无副作用），避免真登记
//   AbortController。

import { vi, type MockInstance } from 'vitest'
import { defaultCore } from './core/coreInstance'

export interface AbortSpies {
  beginRun: MockInstance<typeof defaultCore.abort.beginRun>
  abortRun: MockInstance<typeof defaultCore.abort.abortRun>
  endRun: MockInstance<typeof defaultCore.abort.endRun>
}

/** 每个用例前调用一次，重建 defaultCore.abort 三个方法的 spy（restoreMocks 会清掉旧的）。 */
export function spyOnDefaultAbort(): AbortSpies {
  return {
    beginRun: vi.spyOn(defaultCore.abort, 'beginRun').mockImplementation(() => new AbortController().signal),
    abortRun: vi.spyOn(defaultCore.abort, 'abortRun').mockImplementation(() => {}),
    endRun: vi.spyOn(defaultCore.abort, 'endRun').mockImplementation(() => {}),
  }
}

/** 让挂在 Promise 上的 .finally 微任务跑完。 */
export async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
