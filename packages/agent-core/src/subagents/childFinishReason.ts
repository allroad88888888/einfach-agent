import type { ModelChatResponse } from '@web-agent/ai'
import { narrowToolCalls } from '../runtime/modelTurn'
import {
  FINISH_REASON_ERRORS,
  isAbnormalFinishReason,
} from '../runtime/finishReason'
import { firstAssistantText } from './childModelClient'
import type { DelegateAgentCallContext, SubagentNodeRecord } from './types'
import type { DelegateAgentRuntimeState } from './runtimeState'

const TRUNCATED_TEXT_PREVIEW_LIMIT = 200

/** Throws a diagnostic error when a child response ended for a non-actionable reason. */
export async function assertNormalChildFinish(
  response: ModelChatResponse,
  archiveBasePath: string,
  node: SubagentNodeRecord,
  runtime: DelegateAgentRuntimeState,
  context: DelegateAgentCallContext,
): Promise<void> {
  const finishReason = response.choices?.[0]?.finish_reason ?? null
  const toolCalls = narrowToolCalls(response.choices?.[0]?.message?.tool_calls)
  if (finishReason === 'length' && toolCalls.length > 0) return
  if (!isAbnormalFinishReason(finishReason)) return
  const fullText = finishReason === 'length' ? firstAssistantText(response) : ''
  let partialPath = ''
  if (fullText) {
    const candidate = runtime.archiveFormat.resultPath(archiveBasePath, node.path).replace(/\.md$/, '.partial.md')
    try {
      await runtime.archive.writeText(context, candidate, `${fullText.trim()}\n`)
      partialPath = candidate
    } catch {
      partialPath = ''
    }
  }
  const flat = fullText.replace(/\s+/g, ' ').trim()
  const preview = flat.length > TRUNCATED_TEXT_PREVIEW_LIMIT ? `${flat.slice(0, TRUNCATED_TEXT_PREVIEW_LIMIT)}...` : flat
  const detail = [
    preview ? `截断片段（仅供定位，不完整）: ${preview}` : '',
    partialPath ? `完整残稿已存至 ${partialPath}（未经校验，采信前请自行判断）` : '',
  ].filter(Boolean).join('；')
  throw new Error(detail ? `${FINISH_REASON_ERRORS[finishReason]}；${detail}` : FINISH_REASON_ERRORS[finishReason])
}
