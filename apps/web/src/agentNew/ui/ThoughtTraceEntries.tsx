// 思考轨迹的单条呈现：推理、执行说明、运行时注入与工具调用/结果。

import type { TimelineThinkingItem } from '@einfach-agent/core/timeline'
import type { ModelToolCall, ToolItem } from '@einfach-agent/ai'
import { MessageMarkdown } from './MessageMarkdown'
import { SubagentRunInline } from './SubagentRunInline'

const DETAIL_MAX_CHARS = 20_000

type ToolResultTone = 'success' | 'warning' | 'error'

function compactText(value: string, limit = 160): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact
}

function limitedDetail(value: string): string {
  if (value.length <= DETAIL_MAX_CHARS) return value
  return `${value.slice(0, DETAIL_MAX_CHARS)}\n... 已截断 ${value.length - DETAIL_MAX_CHARS} 个字符`
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonDetail(raw: string): string {
  const parsed = parseJson(raw)
  if (parsed === undefined) return raw || '{}'
  return JSON.stringify(parsed, null, 2)
}

function argValueSummary(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function statusValueSummary(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'boolean') return value ? 'true' : undefined
  if (typeof value === 'number') return value !== 0 ? String(value) : undefined
  if (Array.isArray(value) && value.length > 0) {
    return value
      .map((item) => argValueSummary(item) ?? JSON.stringify(item))
      .filter(Boolean)
      .join('；')
  }
  if (isRecord(value) && Object.keys(value).length > 0) return JSON.stringify(value)
  return undefined
}

function toolResultTone(content: string): ToolResultTone {
  const parsed = parseJson(content)
  if (!isRecord(parsed)) return 'success'
  if (statusValueSummary(parsed.error) || parsed.ok === false || parsed.success === false) {
    return 'error'
  }
  if (statusValueSummary(parsed.warning) || statusValueSummary(parsed.warnings)) {
    return 'warning'
  }
  return 'success'
}

function toolCallSummary(call: ModelToolCall): string {
  const parsed = parseJson(call.function.arguments)
  if (isRecord(parsed)) {
    for (const key of ['toolName', 'name', 'query', 'path', 'command', 'reason']) {
      const value = argValueSummary(parsed[key])
      if (value) return compactText(`${key}=${value}`, 180)
    }
  }
  return compactText(jsonDetail(call.function.arguments), 180)
}

function toolResultSummary(content: string): string {
  const parsed = parseJson(content)
  if (isRecord(parsed)) {
    const error = statusValueSummary(parsed.error)
    if (error) return compactText(`error=${error}`, 180)
    if (parsed.ok === false) return 'ok=false'
    if (parsed.success === false) return 'success=false'
    const warning = statusValueSummary(parsed.warning) ?? statusValueSummary(parsed.warnings)
    if (warning) return compactText(`warning=${warning}`, 180)
    const ok = argValueSummary(parsed.ok)
    if (ok) return compactText(`ok=${ok}`, 180)
  }
  return compactText(content, 180)
}

function DebugEntry({
  variant,
  tone,
  label,
  title,
  summary,
  detail,
}: {
  variant: 'tool-call' | 'tool-result' | 'injection'
  tone?: Exclude<ToolResultTone, 'success'>
  label: string
  title: string
  summary?: string
  detail?: string
}) {
  const className = [
    'agentnew-debug-entry',
    `agentnew-debug-entry--${variant}`,
    tone ? `agentnew-debug-entry--${tone}` : '',
  ].filter(Boolean).join(' ')
  return (
    <div className={className}>
      <div className="agentnew-debug-head">
        <span className="agentnew-debug-label">{label}</span>
        <span className="agentnew-debug-title">{title}</span>
      </div>
      {summary ? <div className="agentnew-debug-summary">{summary}</div> : null}
      {detail ? (
        <details className="agentnew-debug-details">
          <summary>详情</summary>
          <pre>{limitedDetail(detail)}</pre>
        </details>
      ) : null}
    </div>
  )
}

function ToolExecutionEntry({
  call,
  result,
  toolName,
}: {
  call?: ModelToolCall
  result?: ToolItem
  toolName?: string
}) {
  const tone = result ? toolResultTone(result.content) : undefined
  const name = call?.function.name ?? toolName ?? result?.tool_call_id ?? '未知工具'
  const label = !result ? '执行中' : tone === 'error' ? '错误' : tone === 'warning' ? '警告' : '完成'
  const title = !result
    ? `调用工具 ${name}`
    : tone === 'error'
      ? `工具失败 ${name}`
      : tone === 'warning'
        ? `工具警告 ${name}`
        : `工具 ${name}`
  const className = [
    'agentnew-debug-entry',
    'agentnew-debug-entry--tool-execution',
    tone === 'warning' || tone === 'error' ? `agentnew-debug-entry--${tone}` : '',
  ].filter(Boolean).join(' ')
  return (
    <div className={className}>
      <div className="agentnew-debug-head">
        <span className="agentnew-debug-label">{label}</span>
        <span className="agentnew-debug-title">{title}</span>
      </div>
      {call ? <div className="agentnew-debug-summary"><span>调用：</span>{toolCallSummary(call)}</div> : null}
      {result ? (
        <div className="agentnew-debug-summary"><span>结果：</span>{toolResultSummary(result.content)}</div>
      ) : (
        <div className="agentnew-debug-summary agentnew-debug-summary--pending">等待工具返回…</div>
      )}
      <details className="agentnew-debug-details">
        <summary>调用与结果</summary>
        <div className="agentnew-debug-detail-sections">
          {call ? <section><b>调用参数</b><pre>{limitedDetail(jsonDetail(call.function.arguments))}</pre></section> : null}
          <section>
            <b>工具结果</b>
            {result ? <pre>{limitedDetail(jsonDetail(result.content))}</pre> : <p>尚未返回结果。</p>}
          </section>
        </div>
      </details>
    </div>
  )
}

export function ThinkingStep({ entry }: { entry: TimelineThinkingItem }) {
  if (entry.kind === 'reasoning') {
    return (
      <div className="agentnew-thinking-text agentnew-thinking-text--reasoning">
        <span className="agentnew-debug-label">模型思考</span>
        <MessageMarkdown>{entry.content}</MessageMarkdown>
      </div>
    )
  }
  if (entry.kind === 'thinking-message') {
    const content = entry.conversationItem.item.role === 'assistant'
      ? entry.conversationItem.item.content ?? ''
      : ''
    return (
      <div className="agentnew-thinking-text">
        <span className="agentnew-debug-label">执行说明</span>
        <MessageMarkdown>{content}</MessageMarkdown>
      </div>
    )
  }
  if (entry.kind === 'runtime-event') {
    return <DebugEntry variant="injection" label="注入" title={entry.event.title} summary={entry.event.summary} detail={entry.event.detail} />
  }
  const isMultiple = entry.executions.length > 1
  return (
    <div className={`agentnew-tool-execution-group${isMultiple ? ' is-multiple' : ''}`}>
      {entry.executions.map((execution, index) => (
        <div className="agentnew-tool-execution-item" key={execution.call?.id ?? execution.result?.tool_call_id ?? index}>
          <ToolExecutionEntry call={execution.call} result={execution.result} toolName={execution.toolName} />
          {execution.call?.function.name === 'delegate_agent' ? <SubagentRunInline callId={execution.call.id} /> : null}
        </div>
      ))}
    </div>
  )
}
