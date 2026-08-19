import {
  type SubagentArchiveEvent,
  type SubagentArchiveEventType,
} from '@einfach-agent/core/subagents'
import { parseJsonl, type JsonlParseResult } from './jsonl'

// 与 types.ts 的 SubagentArchiveEventType 联合一一对应 —— 漏一个，该类事件就会被
// isSubagentArchiveEvent 判为结构非法而落进 parseErrors，eventCounts 也不再统计它。
// 用 Record 而非数组字面量：数组类型允许子集，漏写不会报错；Record 少一个键编译期就失败，
// 多一个键也会被拒。scripts/subagent-replay-lib.js 里的同名白名单由该文件的测试锁步校验。
const SUBAGENT_EVENT_TYPE_SET: Record<SubagentArchiveEventType, true> = {
  archive_initialized: true,
  delegate_requested: true,
  children_reserved: true,
  skill_written: true,
  child_started: true,
  child_tool_schema_requested: true,
  child_tool_finished: true,
  nested_delegate_requested: true,
  child_finished: true,
  tree_snapshot_written: true,
  delegate_finished: true,
  child_model_usage: true,
  child_model_escalated: true,
  child_context_distillation_started: true,
  child_context_distillation_succeeded: true,
  child_context_distillation_failed: true,
}

export const SUBAGENT_EVENT_TYPES = Object.keys(
  SUBAGENT_EVENT_TYPE_SET,
) as SubagentArchiveEventType[]

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isSubagentArchiveEventType(value: unknown): value is SubagentArchiveEventType {
  return isString(value) && SUBAGENT_EVENT_TYPES.includes(value as SubagentArchiveEventType)
}

function isSubagentArchiveEvent(value: unknown): value is SubagentArchiveEvent {
  if (!isRecord(value)) return false
  if (!isString(value.eventId)) return false
  if (!isString(value.timestamp)) return false
  if (!isString(value.conversationId)) return false
  if (!isString(value.runId)) return false
  if (!isString(value.treeId)) return false
  if (!isString(value.agentPath)) return false
  if (!isSubagentArchiveEventType(value.type)) return false
  return value.data === undefined || isRecord(value.data)
}

export function parseSubagentEvents(text: string): JsonlParseResult<SubagentArchiveEvent> {
  return parseJsonl(text, {
    parse: (value) => isSubagentArchiveEvent(value) ? value : undefined,
    invalidRecordError: 'invalid subagent archive event structure',
  })
}
