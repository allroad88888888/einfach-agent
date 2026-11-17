import type { ToolResult } from './types'

/** Input accepted by the app-owned web search capability. */
export interface WebSearchInput {
  query: string
  count?: number
  ori_question?: string | null
  localization?: string
  need_content?: boolean
}

export type WebSearchCapability = (
  input: WebSearchInput,
  context: { readonly signal: AbortSignal },
) => Promise<ToolResult>
