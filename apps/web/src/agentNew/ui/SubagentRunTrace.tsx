import { useMemo } from 'react'
import type { ModelToolCall } from '@web-agent/ai'
import type { SubagentTraceRecord } from '@web-agent/subagents'
import { MessageMarkdown } from './MessageMarkdown'

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

function toolResultFailed(content: string): boolean {
  try {
    const value = JSON.parse(content) as Record<string, unknown>
    return Boolean(value.error) || value.ok === false || value.success === false
  } catch {
    return false
  }
}

function ToolCallTrace({ call }: { call: ModelToolCall }) {
  return (
    <details className="agentnew-subagent-trace-tool">
      <summary>
        <span>工具调用</span>
        <strong>{call.function.name}</strong>
        <i aria-hidden="true">⌄</i>
      </summary>
      <pre>{prettyJson(call.function.arguments)}</pre>
    </details>
  )
}

function ModelTraceEntry({ record }: { record: SubagentTraceRecord }) {
  if (record.item.role !== 'assistant') return null
  const calls = record.item.tool_calls ?? []
  const isFinal = calls.length === 0
  const hasThinking = Boolean(record.item.reasoning_content?.trim())

  return (
    <details className="agentnew-subagent-trace-entry agentnew-subagent-trace-entry--model">
      <summary>
        <span>{isFinal ? '最终回复' : '模型 thinking'}</span>
        <strong>第 {record.turn} 轮</strong>
        {calls.length > 0 ? <small>{calls.length} 个工具调用</small> : null}
        <i aria-hidden="true">⌄</i>
      </summary>
      <div className="agentnew-subagent-trace-body">
        {hasThinking ? (
          <section>
            <b>思考过程</b>
            <MessageMarkdown>{record.item.reasoning_content ?? ''}</MessageMarkdown>
          </section>
        ) : null}
        {record.item.content?.trim() ? (
          <section>
            <b>{isFinal ? '回答' : '执行说明'}</b>
            <MessageMarkdown>{record.item.content}</MessageMarkdown>
          </section>
        ) : null}
        {!hasThinking && !record.item.content?.trim() && calls.length > 0 ? (
          <p className="agentnew-subagent-trace-empty">本轮模型未返回文字内容。</p>
        ) : null}
        {calls.map((call) => <ToolCallTrace call={call} key={call.id} />)}
      </div>
    </details>
  )
}

/** Renders the model and tool trace captured for one selected subagent. */
export function SubagentRunTrace({ records }: { records: SubagentTraceRecord[] }) {
  const toolNames = useMemo(() => {
    const names = new Map<string, string>()
    for (const record of records) {
      if (record.item.role !== 'assistant') continue
      for (const call of record.item.tool_calls ?? []) names.set(call.id, call.function.name)
    }
    return names
  }, [records])

  return (
    <div className="agentnew-subagent-trace" role="region" aria-label="子 agent 完整运行轨迹">
      {records.map((record, index) => {
        if (record.item.role === 'tool') {
          const failed = toolResultFailed(record.item.content)
          return (
            <details className={`agentnew-subagent-trace-entry agentnew-subagent-trace-entry--tool ${failed ? 'is-error' : 'is-success'}`} key={`${record.timestamp}:${index}`}>
              <summary>
                <span>{failed ? '工具失败' : '工具结果'}</span>
                <strong>{toolNames.get(record.item.tool_call_id) ?? record.item.tool_call_id}</strong>
                <i aria-hidden="true">⌄</i>
              </summary>
              <pre>{prettyJson(record.item.content)}</pre>
            </details>
          )
        }

        return <ModelTraceEntry record={record} key={`${record.timestamp}:${index}`} />
      })}
    </div>
  )
}
