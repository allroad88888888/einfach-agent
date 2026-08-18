import { useAgentAtomValue } from '@web-agent/react-plugin'
import type { ModelToolCall, ToolItem } from '@web-agent/ai'
import {
  subagentTreesAtom,
  type SubagentTraceRecord,
  type SubagentTreeView,
  type SubagentTreeViewNode,
} from '@web-agent/subagents'
import { MessageMarkdown } from './MessageMarkdown'

const STATUS_LABEL: Record<SubagentTreeViewNode['status'], string> = {
  queued: '排队',
  distilling: '提炼',
  running: '运行中',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
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
        <span>子 agent</span>
        <strong>{visibleNodes.length} 个节点</strong>
        <small>{STATUS_LABEL[tree.status]}</small>
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
            {!result ? '工具调用' : tone === 'error' ? '工具失败' : tone === 'warning' ? '工具警告' : '工具'}
          </span>
          <strong>{call.function.name}</strong>
          <small>{result ? '完成' : '执行中'}</small>
          <i aria-hidden="true">⌄</i>
        </summary>
        <div className="agentnew-subagent-trace-tool-sections">
          <section>
            <b>调用参数</b>
            <pre>{prettyJson(call.function.arguments)}</pre>
          </section>
          <section>
            <b>工具结果</b>
            {result ? <pre>{prettyJson(result.content)}</pre> : <p>尚未返回结果。</p>}
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
                <span>{tone === 'error' ? '工具失败' : tone === 'warning' ? '工具警告' : '工具结果'}</span>
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
              <span>{isFinal ? '最终回复' : '模型 thinking'}</span>
              {calls.length > 0 ? <small>{calls.length} 个工具调用</small> : null}
              <i aria-hidden="true">⌄</i>
            </summary>
            <div className="agentnew-subagent-trace-body">
              {record.item.reasoning_content?.trim() ? (
                <section>
                  <b>思考过程</b>
                  <MessageMarkdown>{record.item.reasoning_content}</MessageMarkdown>
                </section>
              ) : null}
              {record.item.content?.trim() ? (
                <section>
                  <b>{isFinal ? '回答' : '执行说明'}</b>
                  <MessageMarkdown>{record.item.content}</MessageMarkdown>
                </section>
              ) : null}
              {!record.item.reasoning_content?.trim() && !record.item.content?.trim() && calls.length > 0 ? (
                <p className="agentnew-subagent-trace-empty">本次模型响应没有文字内容。</p>
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
        <small>{STATUS_LABEL[node.status]}</small>
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
              ? '等待此节点产生模型记录…'
              : '此历史节点没有保存在会话状态中的模型记录。'}
          </p>
        )}
        {node.resultFile || node.skillFiles.length > 0 ? (
          <details className="agentnew-subagent-inline-artifacts">
            <summary>产物</summary>
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
