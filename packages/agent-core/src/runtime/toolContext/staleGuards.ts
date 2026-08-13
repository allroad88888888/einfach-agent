// runtime/toolContext/staleGuards.ts —— ToolContext 的 run 新鲜度守卫（TOOLS-SPEC §5）。
// 安全边界：被新 run 顶掉的旧 run（ghost）和已 abort 的 run 都不许继续写副作用。两个断言逐字沿用
// 拆分前 buildToolContext 里的内联实现，工具侧看不到任何变化。

import { isCurrentRun, type CurrentRunDeps } from '../shared/runGuards'

export interface ToolStaleGuards {
  /** 取消或被顶掉都算 stale：普通副作用一律先过它。 */
  assertFresh(): void
  /** 取消后仍需要写入最终审计事件；但被新 run 顶掉的旧 run 绝不能串写归档。 */
  assertArchiveCurrent(): void
}

export function createStaleGuards(deps: {
  signal: AbortSignal
  currentRun: CurrentRunDeps
}): ToolStaleGuards {
  const { signal, currentRun } = deps

  function assertFresh(): void {
    if (signal.aborted || !isCurrentRun(currentRun)) throw new Error('stale')
  }

  // 取消后仍需要写入最终审计事件；但被新 run 顶掉的旧 run 绝不能串写归档。
  function assertArchiveCurrent(): void {
    if (!isCurrentRun(currentRun)) throw new Error('stale')
  }

  return { assertFresh, assertArchiveCurrent }
}
