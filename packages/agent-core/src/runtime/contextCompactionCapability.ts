import type { ContextCompactionCapability, ContextCompactionReceipt } from '../tools/contextCompaction'
import { requestContextSummary, type ContextDistillationInput } from './contextDistillation'

/** One invocation; callers supply the agent-specific freshness, budget and state rules. */
export function createContextCompactionCapability(input: ContextDistillationInput & {
  assertCurrent(): void
  invoke?(request: () => Promise<string>): Promise<string>
  commit(summary: string): ContextCompactionReceipt
}) {
  let committed: ContextCompactionReceipt | undefined
  let closed = false
  const assertActive = () => {
    if (closed || committed || input.signal.aborted) throw new Error('上下文压缩调用已结束。')
    input.assertCurrent()
  }
  const capability: ContextCompactionCapability = {
    async summarize(policy) {
      assertActive()
      if (!policy.instructions.trim() || !policy.request.trim()
        || !Number.isSafeInteger(policy.maxOutputTokens)
        || policy.maxOutputTokens < 1 || policy.maxOutputTokens > 8_192) {
        throw new Error('无效的上下文摘要请求。')
      }
      const request = () => requestContextSummary(input, policy)
      const summary = await (input.invoke ? input.invoke(request) : request())
      assertActive()
      return summary
    },
    commit(summary) {
      assertActive()
      const text = summary.trim()
      if (!text) throw new Error('上下文摘要为空，已保留原始历史。')
      committed = input.commit(text)
      return committed
    },
  }
  return {
    capability,
    get committed() { return committed },
    close() { closed = true },
  }
}
