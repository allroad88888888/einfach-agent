import { useAgentAtomValue } from '@einfach-agent/react-plugin'
import type { ModelToolCall, ToolItem } from '@einfach-agent/ai'
import { Trans, useLingui } from '@lingui/react/macro'
import {
  subagentTreesAtom,
  type SubagentTraceRecord,
  type SubagentTreeView,
  type SubagentTreeViewNode,
} from '@einfach-agent/subagents'
import { MessageMarkdown } from './MessageMarkdown'

function SubagentStatus({ status }: { status: SubagentTreeViewNode['status'] }) {
  const { t } = useLingui()
  const labels: Record<SubagentTreeViewNode['status'], string> = {
    queued: t`排队`,
    distilling: t`提炼`,
    running: t`运行中`,
    done: t`完成`,
    failed: t`失败`,
    cancelled: t`已取消`,
    interrupted: t`已中断`,
  }
  return labels[status]
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

function toolResultTone(content: string): 'success' | 'warning' | 'error' {
  try {
    const value = JSON.parse(content) as Record<string, unknown>
    if (value.error || value.ok === false || value.success === false) return 'error'
    if (Array.isArray(value.warnings) && value.warnings.length > 0) return 'warning'
  } catch {
    // Plain-text tool output is a normal successful result.
  }
  return 'success'
}

function InlineDelegate({
  callId,
  trees,
  ancestorCallIds,
}: {
  callId: string
  trees: SubagentTreeView[]
  ancestorCallIds: ReadonlySet<string>
}) {
  const tree = trees.find((candidate) => candidate.callId === callId)
  if (!tree || ancestorCallIds.has(callId)) return null
  const nextAncestors = new Set(ancestorCallIds)
  nextAncestors.add(callId)
  const childNodes = tree.nodes.filter((node) => node.depth > 0)
  const visibleNodes = childNodes.length > 0 ? childNodes : tree.nodes

  return (
    <details className="agentnew-subagent-inline" data-status={tree.status}>
      <summary>
        <span><Trans>子 agent</Trans></span>
        <strong><Trans>{visibleNodes.length} 个节点</Trans></strong>
        <small><SubagentStatus status={tree.status} /></small>
        <i aria-hidden="true">⌄</i>
      </summary>
      <div className={`agentnew-subagent-inline-nodes${visibleNodes.length > 1 ? ' is-concurrent' : ''}`}>
        {visibleNodes.map((node) => (
          <SubagentNodeTrace
            ancestorCallIds={nextAncestors}
            key={node.key}
            node={node}
            trees={trees}
          />
        ))}
      </div>
    </details>
  )
}

function ToolCallTrace({
  call,
  result,
  trees,
  ancestorCallIds,
}: {
  call: ModelToolCall
  result?: ToolItem
  trees: SubagentTreeView[]
  ancestorCallIds: ReadonlySet<string>
}) {
  const tone = result ? toolResultTone(result.content) : undefined
  return (
    <div className="agentnew-subagent-trace-tool-wrap">
      <details className={`agentnew-subagent-trace-tool${tone ? ` is-${tone}` : ''}`}>
        <summary>
          <span>
            {!result
              ? <Trans>工具调用</Trans>
              : tone === 'error'
                ? <Trans>工具失败</Trans>
                : tone === 'warning' ? <Trans>工具警告</Trans> : <Trans>工具</Trans>}
          </span>
          <strong>{call.function.name}</strong>
          <small>{result ? <Trans>完成</Trans> : <Trans>执行中</Trans>}</small>
          <i aria-hidden="true">⌄</i>
        </summary>
        <div className="agentnew-subagent-trace-tool-sections">
          <section>
            <b><Trans>调用参数</Trans></b>
            <pre>{prettyJson(call.function.arguments)}</pre>
          </section>
          <section>
            <b><Trans>工具结果</Trans></b>
            {result ? <pre>{prettyJson(result.content)}</pre> : <p><Trans>尚未返回结果。</Trans></p>}
          </section>
        </div>
      </details>
      {call.function.name === 'delegate_agent' ? (
        <InlineDelegate
          ancestorCallIds={ancestorCallIds}
          callId={call.id}
          trees={trees}
        />
      ) : null}
    </div>
  )
}

function TraceRecords({
  records,
  trees,
  ancestorCallIds,
}: {
  records: SubagentTraceRecord[]
  trees: SubagentTreeView[]
  ancestorCallIds: ReadonlySet<string>
}) {
  const toolNames = new Map<string, string>()
  const toolResults = new Map<string, ToolItem>()
  for (const record of records) {
    if (record.item.role === 'assistant') {
      for (const call of record.item.tool_calls ?? []) toolNames.set(call.id, call.function.name)
    } else {
      toolResults.set(record.item.tool_call_id, record.item)
    }
  }

  return (
    <div className="agentnew-subagent-trace">
      {records.map((record, index) => {
        if (record.item.role === 'tool') {
          if (toolNames.has(record.item.tool_call_id)) return null
          const tone = toolResultTone(record.item.content)
          return (
            <details
              className={`agentnew-subagent-trace-entry agentnew-subagent-trace-entry--tool is-${tone}`}
              key={`${record.timestamp}:${index}`}
            >
              <summary>
                <span>
                  {tone === 'error'
                    ? <Trans>工具失败</Trans>
                    : tone === 'warning' ? <Trans>工具警告</Trans> : <Trans>工具结果</Trans>}
                </span>
                <strong>{toolNames.get(record.item.tool_call_id) ?? record.item.tool_call_id}</strong>
                <i aria-hidden="true">⌄</i>
              </summary>
              <pre>{prettyJson(record.item.content)}</pre>
            </details>
          )
        }

        const calls = record.item.tool_calls ?? []
        const isFinal = calls.length === 0
        return (
          <details
            className="agentnew-subagent-trace-entry agentnew-subagent-trace-entry--model"
            key={`${record.timestamp}:${index}`}
          >
            <summary>
              <span>{isFinal ? <Trans>最终回复</Trans> : <Trans>模型 thinking</Trans>}</span>
              {calls.length > 0 ? <small><Trans>{calls.length} 个工具调用</Trans></small> : null}
              <i aria-hidden="true">⌄</i>
            </summary>
            <div className="agentnew-subagent-trace-body">
              {record.item.reasoning_content?.trim() ? (
                <section>
                  <b><Trans>思考过程</Trans></b>
                  <MessageMarkdown>{record.item.reasoning_content}</MessageMarkdown>
                </section>
              ) : null}
              {record.item.content?.trim() ? (
                <section>
                  <b>{isFinal ? <Trans>回答</Trans> : <Trans>执行说明</Trans>}</b>
                  <MessageMarkdown>{record.item.content}</MessageMarkdown>
                </section>
              ) : null}
              {!record.item.reasoning_content?.trim() && !record.item.content?.trim() && calls.length > 0 ? (
                <p className="agentnew-subagent-trace-empty"><Trans>本次模型响应没有文字内容。</Trans></p>
              ) : null}
              {calls.map((call) => (
                <ToolCallTrace
                  ancestorCallIds={ancestorCallIds}
                  call={call}
                  key={call.id}
                  result={toolResults.get(call.id)}
                  trees={trees}
                />
              ))}
            </div>
          </details>
        )
      })}
    </div>
  )
}

function SubagentNodeTrace({
  node,
  trees,
  ancestorCallIds,
}: {
  node: SubagentTreeViewNode
  trees: SubagentTreeView[]
  ancestorCallIds: ReadonlySet<string>
}) {
  return (
    <details className="agentnew-subagent-inline-node" data-status={node.status}>
      <summary>
        <span className="agentnew-subagent-inline-objective">{node.objective}</span>
        <small><SubagentStatus status={node.status} /></small>
        <i aria-hidden="true">⌄</i>
      </summary>
      <div className="agentnew-subagent-inline-node-body">
        {node.error ? <p className="agentnew-subagent-error">{node.error}</p> : null}
        {node.trace && node.trace.length > 0 ? (
          <TraceRecords
            ancestorCallIds={ancestorCallIds}
            records={node.trace}
            trees={trees}
          />
        ) : (
          <p className="agentnew-subagent-trace-empty">
            {node.status === 'queued' || node.status === 'running' || node.status === 'distilling'
              ? <Trans>等待此节点产生模型记录…</Trans>
              : <Trans>此历史节点没有保存在会话状态中的模型记录。</Trans>}
          </p>
        )}
        {node.resultFile || node.skillFiles.length > 0 ? (
          <details className="agentnew-subagent-inline-artifacts">
            <summary><Trans>产物</Trans></summary>
            {node.resultFile ? <code>{node.resultFile}</code> : null}
            {node.skillFiles.map((path) => <code key={path}>{path}</code>)}
          </details>
        ) : null}
      </div>
    </details>
  )
}

export function SubagentRunInline({ callId }: { callId: string }) {
  const trees = useAgentAtomValue(subagentTreesAtom)
  return (
    <InlineDelegate
      ancestorCallIds={new Set()}
      callId={callId}
      trees={trees}
    />
  )
}
