// runtime/toolEpochStore.ts —— 工具集 epoch 的【归属与生命周期】（每个 CoreInstance 一份）。
//
// 为什么 epoch 不能只是 runToolLoop 里的一个局部变量：run 会在循环外存活。危险工具确认、
// ask_user、计划审批都会让 runToolLoop 返回，等用户点完再以【同一个 runId】重新进入。
// 若每次进入都重新 snapshot，那段「等用户」的窗口——恰恰是 MCP 最可能重连或掉线的几分钟——
// 就会换掉本 run 的工具集，E1 的承诺当场作废。所以 epoch 按 (sessionId, runId) 存放，
// 同一个 runId 重入时复用同一份。
//
// 容量：一个会话同时只有一个活 run（abort registry 也是每会话一个 controller），因此这里
// 每个会话只留最新的一条，新 runId 直接顶掉旧的；会话被 drop 时一并释放。

import { createToolEpoch, type ToolEpoch } from './toolEpoch'
import type { ToolRegistry } from '../tools/toolRegistry'

export interface ToolEpochStore {
  /** 取本 run 的 epoch；同一 runId 复用，换了 runId 则重新冻结一份。 */
  ensure(sessionId: string, runId: string): ToolEpoch
  /**
   * 只读查询，不会创建。
   *
   * 循环之外的命令层（如待确认工具恢复）用它拿回本 run 的判据：拿不到就说明这个 run 的
   * epoch 已经不在（进程重启或被新 run 顶掉），调用方应回退到自己的兜底策略。
   */
  get(sessionId: string, runId: string): ToolEpoch | undefined
  release(sessionId: string): void
  reset(): void
}

/** 建一个绑定该 registry 的 epoch 存储。 */
export function createToolEpochStore(registry: ToolRegistry): ToolEpochStore {
  const epochs = new Map<string, ToolEpoch>()

  return {
    ensure(sessionId, runId) {
      const current = epochs.get(sessionId)
      if (current?.runId === runId) return current
      const epoch = createToolEpoch(registry, { sessionId, runId })
      epochs.set(sessionId, epoch)
      return epoch
    },
    get(sessionId, runId) {
      const current = epochs.get(sessionId)
      return current?.runId === runId ? current : undefined
    },
    release(sessionId) {
      epochs.delete(sessionId)
    },
    reset() {
      epochs.clear()
    },
  }
}
