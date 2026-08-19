import { atom } from '@einfach/core'
import type { AssistantItem, ToolItem } from '@einfach-agent/ai'
import { createLatestOnlyLoader } from './createLatestOnlyLoader'
import { isMissingSubagentArchiveError } from './subagentArchiveErrors'
import {
  parseJsonl,
  readSubagentArchiveFile,
  subagentTracePath,
  type ArchiveReader,
} from './subagentArchiveReader'
import { isRecord } from './subagentViewRecord'
import type { SubagentTraceRecord, SubagentTraceState } from './subagentViewTypes'

export const subagentTraceAtom = atom<SubagentTraceState>({
  status: 'idle',
  records: [],
  warnings: [],
})
const subagentTraceLoader = createLatestOnlyLoader()

export function isSubagentTraceModelItem(value: unknown): value is AssistantItem | ToolItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (item.role === 'assistant') {
    return (typeof item.content === 'string' || item.content === null) &&
      (item.reasoning_content === undefined ||
        item.reasoning_content === null ||
        typeof item.reasoning_content === 'string') &&
      (item.tool_calls === undefined || Array.isArray(item.tool_calls))
  }
  return item.role === 'tool' &&
    typeof item.tool_call_id === 'string' &&
    typeof item.content === 'string'
}

export function parseSubagentTrace(text: string): {
  records: SubagentTraceRecord[]
  warnings: string[]
} {
  const parsed = parseJsonl(text, {
    parse: (value): SubagentTraceRecord | undefined => {
      if (!isRecord(value)) return undefined
      if (
        typeof value.timestamp !== 'string' ||
        typeof value.turn !== 'number' ||
        !Number.isFinite(value.turn) ||
        !isSubagentTraceModelItem(value.item)
      ) return undefined
      return { timestamp: value.timestamp, turn: value.turn, item: value.item }
    },
    invalidRecordError: 'invalid subagent trace record',
  })
  return {
    records: parsed.records,
    warnings: parsed.parseErrors.map((error) => error.error === 'invalid subagent trace record'
      ? `轨迹第 ${error.line} 行结构无效`
      : `轨迹第 ${error.line} 行无法解析：${error.error}`),
  }
}

export const loadSubagentTraceAtom = atom(
  null,
  async (get, set, input: {
    archiveBasePath: string
    agentPath: string
    nodeKey: string
    workspaceRoot?: string
    reader?: ArchiveReader
    silent?: boolean
  }) => {
    const path = subagentTracePath(input.archiveBasePath, input.agentPath)
    const token = subagentTraceLoader.start(get, set)
    const current = get(subagentTraceAtom)
    if (!input.silent || current.nodeKey !== input.nodeKey) {
      set(subagentTraceAtom, {
        status: 'loading',
        path,
        nodeKey: input.nodeKey,
        records: [],
        warnings: [],
      })
    }
    const result = await readSubagentArchiveFile({
      path,
      maxBytes: 2_000_000,
      workspaceRoot: input.workspaceRoot,
    }, input.reader)
    if (!subagentTraceLoader.isLatest(get, token)) return
    if (!result.ok) {
      set(subagentTraceAtom, {
        status: isMissingSubagentArchiveError(result.error) ? 'empty' : 'error',
        path,
        nodeKey: input.nodeKey,
        records: [],
        warnings: [],
        error: result.error,
      })
      return
    }
    const parsed = parseSubagentTrace(result.data.content)
    const warnings = result.data.truncated
      ? [`${path} 超过 2MB，仅显示已读取部分`, ...parsed.warnings]
      : parsed.warnings
    set(subagentTraceAtom, {
      status: parsed.records.length > 0 ? 'ready' : 'empty',
      path,
      nodeKey: input.nodeKey,
      records: parsed.records,
      warnings,
      error: parsed.records.length > 0 ? undefined : '此节点没有已归档的模型轨迹',
    })
  },
)
