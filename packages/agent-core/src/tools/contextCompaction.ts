/** Summary policy supplied by the compaction tool; credentials and history stay in the runtime. */
export interface ContextSummaryRequest {
  instructions: string
  request: string
  maxOutputTokens: number
}

export interface ContextCompactionReceipt {
  coveredItems: number
  sourceEstimatedTokens: number
  summaryChars: number
}

/** Bound to one captured agent context and valid only for its current compaction invocation. */
export interface ContextCompactionCapability {
  summarize(request: ContextSummaryRequest): Promise<string>
  commit(summary: string): ContextCompactionReceipt
}

export const COMPACT_CONTEXT_TOOL_NAME = 'compact_context'
