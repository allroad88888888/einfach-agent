// 右栏消息列表（P-U3 / P8-g）——在「当前会话 store」的 Provider 下，
// 读 itemsAtom + browserCardsAtom + runtimeTranscriptEventsAtom，把助手回复、工具调用/结果、
// 运行时注入事件与浏览器卡片按时间合并渲染。
// ---------------------------------------------------------------------------
// 契约（U1）：业务数据只读 atom；思考组展开与消息窗口属于会话内 UI 状态，
// 直接写对应 atom。用户消息的回退入口只调用命令，不碰 store / writer。
// 可见性规则：
//   · user：渲染为右侧消息气泡；
//   · assistant：reasoning_content 归入思考过程；最终 content 渲染文本气泡；
//     带 tool_calls 的中间 content 作为执行说明归入思考过程；
//   · tool：通过 tool_call_id 合并进对应工具调用卡片；
//   · runtime transcript event / 工具执行：连续项合并为默认展开的思考过程；
//   · system ConversationItem：仍然不渲染，避免把异常入库的 system 当成正常 transcript。

import { useAtom, useAtomValue } from '@einfach/react'
import {
  useCallback,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react'
import { revertTurnToDraft } from '@web-agent/core/runtime/commands'
import { checkpointsAtom, itemsAtom, runAtom } from '@web-agent/core/state/sessionAtoms'
import {
  assistantStreamAtom,
  browserCardsAtom,
  expandedTranscriptGroupsAtom,
  runtimeTranscriptEventsAtom,
  type BrowserCard,
  type RuntimeTranscriptEvent,
} from '@web-agent/core/state/transientAtoms'
import type { ConversationItem, RunState } from '@web-agent/core/state/core.type'
import type { ModelToolCall, ToolItem } from '@web-agent/ai'
import { BrowserActionCard } from './BrowserActionCard'
import { MessageMarkdown } from './MessageMarkdown'
import {
  messageElapsedClockAtom,
  messageWindowAtom,
  planTraceWindowsAtom,
} from './messageWindowModel'
import { SubagentRunInline } from './SubagentRunInline'
import { SlidingWindowRow, useSlidingWindow } from './useSlidingWindow'

const DETAIL_MAX_CHARS = 20_000

// 合并渲染的条目：对话消息、工具调试行、runtime 注入事件或浏览器卡片。
type MergedEntry =
  | { kind: 'message'; createdAt: number; sortKey: string; ci: ConversationItem }
  | { kind: 'reasoning'; createdAt: number; sortKey: string; content: string }
  | { kind: 'thinking-message'; createdAt: number; sortKey: string; ci: ConversationItem }
  | {
      kind: 'tool-execution-group'
      createdAt: number
      sortKey: string
      executions: Array<{
        call?: ModelToolCall
        result?: ToolItem
        toolName?: string
      }>
    }
  | { kind: 'runtime-event'; createdAt: number; sortKey: string; event: RuntimeTranscriptEvent }
  | { kind: 'card'; createdAt: number; sortKey: string; card: BrowserCard }

type ThinkingEntry = Extract<
  MergedEntry,
  { kind: 'reasoning' | 'thinking-message' | 'tool-execution-group' | 'runtime-event' }
>

type RenderEntry =
  | Exclude<MergedEntry, ThinkingEntry>
  | { kind: 'thinking-group'; createdAt: number; sortKey: string; entries: ThinkingEntry[] }

type VirtualEntry =
  | Exclude<RenderEntry, { kind: 'thinking-group' }>
  | {
      kind: 'thinking-header'
      createdAt: number
      sortKey: string
      group: Extract<RenderEntry, { kind: 'thinking-group' }>
    }
  | {
      kind: 'thinking-step-row'
      createdAt: number
      sortKey: string
      entry: ThinkingEntry
    }

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

  if (
    statusValueSummary(parsed.error) ||
    parsed.ok === false ||
    parsed.success === false
  ) {
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

function buildToolExecutionIndex(items: ConversationItem[]): {
  calls: Map<string, ModelToolCall>
  results: Map<string, ToolItem>
} {
  const calls = new Map<string, ModelToolCall>()
  const results = new Map<string, ToolItem>()
  for (const { item } of items) {
    if (item.role === 'assistant') {
      for (const call of item.tool_calls ?? []) calls.set(call.id, call)
    } else if (item.role === 'tool') {
      results.set(item.tool_call_id, item)
    }
  }
  return { calls, results }
}

function itemEntries(
  ci: ConversationItem,
  itemIndex: number,
  toolExecutionIndex: ReturnType<typeof buildToolExecutionIndex>,
): MergedEntry[] {
  const baseKey = `item:${String(itemIndex).padStart(6, '0')}:${ci.id}`
  const item = ci.item
  if (item.role === 'user') {
    return [{ kind: 'message', createdAt: ci.createdAt, sortKey: `${baseKey}:message`, ci }]
  }

  if (item.role === 'assistant') {
    const entries: MergedEntry[] = []
    if (typeof item.reasoning_content === 'string' && item.reasoning_content.trim() !== '') {
      entries.push({
        kind: 'reasoning',
        createdAt: ci.createdAt,
        sortKey: `${baseKey}:00-reasoning`,
        content: item.reasoning_content,
      })
    }
    if (typeof item.content === 'string' && item.content.trim() !== '') {
      entries.push({
        kind: item.tool_calls?.length ? 'thinking-message' : 'message',
        createdAt: ci.createdAt,
        sortKey: `${baseKey}:01-message`,
        ci,
      })
    }
    if (item.tool_calls?.length) {
      entries.push({
        kind: 'tool-execution-group',
        createdAt: ci.createdAt,
        sortKey: `${baseKey}:02-tool-execution-group`,
        executions: item.tool_calls.map((call) => ({
          call,
          result: toolExecutionIndex.results.get(call.id),
        })),
      })
    }
    return entries
  }

  if (item.role === 'tool') {
    if (toolExecutionIndex.calls.has(item.tool_call_id)) return []
    return [
      {
        kind: 'tool-execution-group',
        createdAt: ci.createdAt,
        sortKey: `${baseKey}:tool-execution-group`,
        executions: [{
          result: item,
          toolName: item.tool_call_id,
        }],
      },
    ]
  }

  // system ConversationItem 不展示；正常 system 注入通过 runtime transcript event 展示。
  return []
}

function isThinkingEntry(entry: MergedEntry): entry is ThinkingEntry {
  return entry.kind === 'reasoning' ||
    entry.kind === 'thinking-message' ||
    entry.kind === 'tool-execution-group' ||
    entry.kind === 'runtime-event'
}

function groupThinkingEntries(entries: MergedEntry[]): RenderEntry[] {
  const grouped: RenderEntry[] = []
  for (const entry of entries) {
    if (!isThinkingEntry(entry)) {
      grouped.push(entry)
      continue
    }
    const previous = grouped.at(-1)
    if (previous?.kind === 'thinking-group') {
      previous.entries.push(entry)
    } else {
      grouped.push({
        kind: 'thinking-group',
        createdAt: entry.createdAt,
        sortKey: `thinking:${entry.sortKey}`,
        entries: [entry],
      })
    }
  }
  return grouped
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
  const label = !result
    ? '执行中'
    : tone === 'error'
      ? '错误'
      : tone === 'warning'
        ? '警告'
        : '完成'
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
      {call ? (
        <div className="agentnew-debug-summary">
          <span>调用：</span>
          {toolCallSummary(call)}
        </div>
      ) : null}
      {result ? (
        <div className="agentnew-debug-summary">
          <span>结果：</span>
          {toolResultSummary(result.content)}
        </div>
      ) : (
        <div className="agentnew-debug-summary agentnew-debug-summary--pending">
          等待工具返回…
        </div>
      )}
      <details className="agentnew-debug-details">
        <summary>调用与结果</summary>
        <div className="agentnew-debug-detail-sections">
          {call ? (
            <section>
              <b>调用参数</b>
              <pre>{limitedDetail(jsonDetail(call.function.arguments))}</pre>
            </section>
          ) : null}
          <section>
            <b>工具结果</b>
            {result
              ? <pre>{limitedDetail(jsonDetail(result.content))}</pre>
              : <p>尚未返回结果。</p>}
          </section>
        </div>
      </details>
    </div>
  )
}

function ThinkingStep({ entry }: { entry: ThinkingEntry }) {
  if (entry.kind === 'reasoning') {
    return (
      <div className="agentnew-thinking-text agentnew-thinking-text--reasoning">
        <span className="agentnew-debug-label">模型思考</span>
        <MessageMarkdown>{entry.content}</MessageMarkdown>
      </div>
    )
  }
  if (entry.kind === 'thinking-message') {
    const content = entry.ci.item.role === 'assistant' ? entry.ci.item.content ?? '' : ''
    return (
      <div className="agentnew-thinking-text">
        <span className="agentnew-debug-label">执行说明</span>
        <MessageMarkdown>{content}</MessageMarkdown>
      </div>
    )
  }
  if (entry.kind === 'runtime-event') {
    return (
      <DebugEntry
        variant="injection"
        label="注入"
        title={entry.event.title}
        summary={entry.event.summary}
        detail={entry.event.detail}
      />
    )
  }
  if (entry.kind === 'tool-execution-group') {
    const isMultiple = entry.executions.length > 1
    return (
      <div className={`agentnew-tool-execution-group${isMultiple ? ' is-multiple' : ''}`}>
        {entry.executions.map((execution, index) => (
          <div
            className="agentnew-tool-execution-item"
            key={execution.call?.id ?? execution.result?.tool_call_id ?? index}
          >
            <ToolExecutionEntry
              call={execution.call}
              result={execution.result}
              toolName={execution.toolName}
            />
            {execution.call?.function.name === 'delegate_agent'
              ? <SubagentRunInline callId={execution.call.id} />
              : null}
          </div>
        ))}
      </div>
    )
  }
}

export function buildPlanStageExecutionEntries(
  items: ConversationItem[],
): Map<string, ThinkingEntry[]> {
  const entriesByStage = new Map<string, ThinkingEntry[]>()
  const toolExecutionIndex = buildToolExecutionIndex(items)
  items.forEach((ci, index) => {
    if (!ci.planStageId) return
    const entries = itemEntries(ci, index, toolExecutionIndex)
      .map((entry): MergedEntry => (
        entry.kind === 'message' && entry.ci.item.role === 'assistant'
          ? { ...entry, kind: 'thinking-message' }
          : entry
      ))
      .filter(isThinkingEntry)
    if (entries.length === 0) return
    const current = entriesByStage.get(ci.planStageId) ?? []
    current.push(...entries)
    entriesByStage.set(ci.planStageId, current)
  })
  for (const entries of entriesByStage.values()) {
    entries.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
      return a.sortKey.localeCompare(b.sortKey)
    })
  }
  return entriesByStage
}

export function PlanStageExecutionTrace({
  windowId,
  stageId,
  entries = [],
}: {
  windowId: string
  stageId: string
  entries?: ThinkingEntry[]
}) {
  const [traceWindows, setTraceWindows] = useAtom(planTraceWindowsAtom)
  const storedWindow = traceWindows[windowId] ?? {
    start: 0,
    end: 0,
    direction: 'idle',
  }
  const setStoredWindow = useCallback((next: typeof storedWindow) => {
    setTraceWindows((current) => ({
      ...current,
      [windowId]: next,
    }))
  }, [setTraceWindows, windowId])
  const latestEntry = entries.at(-1)
  const {
    registerRow,
    scrollRef,
    window: traceWindow,
  } = useSlidingWindow({
    total: entries.length,
    storedWindow,
    setStoredWindow,
    latestVersion: latestEntry ? `${latestEntry.sortKey}:${latestEntry.createdAt}` : '',
  })
  const visibleEntries = entries.slice(traceWindow.start, traceWindow.end)

  return (
    <section className="agentnew-plan-stage-trace" aria-label={`${stageId} 步骤执行记录`}>
      <strong className="agentnew-plan-section-title">执行记录</strong>
      {entries.length > 0 ? (
        <div
          ref={scrollRef}
          className="agentnew-thinking-steps agentnew-plan-stage-trace-window"
        >
          {visibleEntries.map((entry) => (
            <SlidingWindowRow
              key={entry.sortKey}
              rowKey={entry.sortKey}
              register={registerRow}
              className="agentnew-plan-trace-row"
            >
              <ThinkingStep entry={entry} />
            </SlidingWindowRow>
          ))}
        </div>
      ) : (
        <span className="agentnew-plan-stage-trace-empty">尚无模型思考或工具调用</span>
      )}
    </section>
  )
}

function flattenVirtualEntries(
  entries: RenderEntry[],
  expandedGroups: Record<string, boolean>,
): VirtualEntry[] {
  return entries.flatMap((entry): VirtualEntry[] => {
    if (entry.kind !== 'thinking-group') return [entry]
    const header: VirtualEntry = {
      kind: 'thinking-header',
      createdAt: entry.createdAt,
      sortKey: entry.sortKey,
      group: entry,
    }
    if (expandedGroups[entry.sortKey] === false) return [header]
    return [
      header,
      ...entry.entries.map((thinkingEntry): VirtualEntry => ({
        kind: 'thinking-step-row',
        createdAt: thinkingEntry.createdAt,
        sortKey: `${entry.sortKey}:step:${thinkingEntry.sortKey}`,
        entry: thinkingEntry,
      })),
    ]
  })
}

function virtualEntryVersion(entry: VirtualEntry): string {
  if (entry.kind === 'thinking-header') {
    return `${entry.sortKey}:${entry.group.entries.length}`
  }
  if (entry.kind === 'thinking-step-row') {
    const item = entry.entry
    if (item.kind === 'reasoning') return `${entry.sortKey}:${item.content.length}`
    if (item.kind === 'thinking-message' && item.ci.item.role === 'assistant') {
      return `${entry.sortKey}:${item.ci.item.content?.length ?? 0}:${item.ci.pending ? 1 : 0}`
    }
    if (item.kind === 'tool-execution-group') {
      return `${entry.sortKey}:${item.executions.map((execution) => (
        `${execution.call?.id ?? ''}:${execution.result?.content.length ?? 0}`
      )).join('|')}`
    }
    return entry.sortKey
  }
  if (entry.kind === 'card') {
    return `${entry.sortKey}:${entry.card.title.length}:${entry.card.body?.length ?? 0}`
  }
  const item = entry.ci.item
  const length = item.role === 'assistant' || item.role === 'user'
    ? item.content?.length ?? 0
    : 0
  return `${entry.sortKey}:${length}:${entry.ci.pending ? 1 : 0}`
}

function formatElapsedDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000))
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function runStartIndex(items: ConversationItem[], turnId?: string): number {
  if (turnId) {
    const anchored = items.findIndex((item) => item.id === turnId)
    if (anchored >= 0) return anchored
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].item.role === 'user') return index
  }
  return -1
}

function RunDurationStatus({
  items,
  run,
}: {
  items: ConversationItem[]
  run?: RunState
}) {
  const [clock, setClock] = useAtom(messageElapsedClockAtom)
  const working = run?.status === 'running' || run?.status === 'awaiting_tool'

  useEffect(() => {
    if (!working) return
    const updateClock = () => setClock(Date.now())
    updateClock()
    const timer = window.setInterval(updateClock, 1_000)
    return () => window.clearInterval(timer)
  }, [run?.runId, setClock, working])

  if (!run || (!working && run.status !== 'done')) return null
  const startIndex = runStartIndex(items, run.turnId)
  if (startIndex < 0) return null

  const startedAt = run.startedAt ?? items[startIndex].createdAt
  let endedAt = startedAt
  for (let index = startIndex; index < items.length; index += 1) {
    endedAt = Math.max(endedAt, items[index].createdAt)
  }
  endedAt = run.finishedAt ?? endedAt
  const durationMs = Math.max(0, (working ? clock : endedAt) - startedAt)
  const duration = formatElapsedDuration(durationMs)
  const label = working ? 'Working' : 'Brewed'

  return (
    <div
      className={`agentnew-run-duration${working ? ' is-working' : ' is-complete'}`}
      aria-label={working ? `对话正在进行，已用时 ${duration}` : `对话已结束，用时 ${duration}`}
    >
      <span className="agentnew-run-duration-mark" aria-hidden="true">
        {working ? null : '✓'}
      </span>
      <span>
        <strong>{label}</strong>
        {' for '}
        <time dateTime={`PT${Math.floor(durationMs / 1_000)}S`}>{duration}</time>
      </span>
    </div>
  )
}

export function MessageList() {
  const items = useAtomValue(itemsAtom)
  const run = useAtomValue(runAtom)
  const assistantStream = useAtomValue(assistantStreamAtom)
  const checkpoints = useAtomValue(checkpointsAtom)
  const cards = useAtomValue(browserCardsAtom)
  const runtimeEvents = useAtomValue(runtimeTranscriptEventsAtom)
  const [expandedGroups, setExpandedGroups] = useAtom(expandedTranscriptGroupsAtom)
  const [storedWindow, setMessageWindow] = useAtom(messageWindowAtom)
  const streamedItemId = assistantStream?.item.id

  // 流式占位条目也在 itemsAtom 中，但正文更新只走 assistantStreamAtom。历史索引排除占位，
  // 让每个 delta 只重算当前这一条消息，不扫描整段会话。
  const historicalItems = useMemo(
    () => streamedItemId ? items.filter((item) => item.id !== streamedItemId) : items,
    [items, streamedItemId],
  )

  const checkpointTurnByUserItemId = useMemo(() => {
    const turns = new Map<string, number>()
    for (const checkpoint of checkpoints) {
      for (let index = checkpoint.items.length - 1; index >= 0; index -= 1) {
        const checkpointItem = checkpoint.items[index]
        if (checkpointItem.item.role !== 'user') continue
        turns.set(checkpointItem.id, checkpoint.turnIndex)
        break
      }
    }
    return turns
  }, [checkpoints])

  const historicalEntries = useMemo<RenderEntry[]>(() => {
    const toolExecutionIndex = buildToolExecutionIndex(historicalItems)
    const merged = [
      ...historicalItems.flatMap((ci, index) => (
        itemEntries(ci, index, toolExecutionIndex)
          // 当前计划步骤产生的 assistant 文本也是阶段执行说明，不是全局最终答复。
          // 它和该步骤的模型思考/工具记录一起只在步骤详情中展示。
          .filter((entry) => (
            !ci.planStageId ||
            entry.kind !== 'message' ||
            entry.ci.item.role !== 'assistant'
          ))
          .filter((entry) => !ci.planStageId || !isThinkingEntry(entry))
      )),
      ...runtimeEvents.map<MergedEntry>((event, index) => ({
        kind: 'runtime-event',
        createdAt: event.createdAt,
        sortKey: `runtime:${String(index).padStart(6, '0')}:${event.id}`,
        event,
      })),
      ...cards.map<MergedEntry>((card) => ({
        kind: 'card',
        createdAt: card.createdAt,
        sortKey: `card:${card.id}`,
        card,
      })),
    ].sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
      if (a.sortKey < b.sortKey) return -1
      if (a.sortKey > b.sortKey) return 1
      return 0
    })
    return groupThinkingEntries(merged)
  }, [cards, historicalItems, runtimeEvents])

  const streamingEntries = useMemo<RenderEntry[]>(() => {
    const ci = assistantStream?.item
    if (!ci) return []
    const toolExecutionIndex = buildToolExecutionIndex([ci])
    const merged = itemEntries(ci, historicalItems.length, toolExecutionIndex)
      .filter((entry) => (
        !ci.planStageId ||
        entry.kind !== 'message' ||
        entry.ci.item.role !== 'assistant'
      ))
      .filter((entry) => !ci.planStageId || !isThinkingEntry(entry))
    return groupThinkingEntries(merged)
  }, [assistantStream, historicalItems.length])

  const historicalVirtualEntries = useMemo(
    () => flattenVirtualEntries(historicalEntries, expandedGroups),
    [historicalEntries, expandedGroups],
  )
  const streamingVirtualEntries = useMemo(
    () => flattenVirtualEntries(streamingEntries, expandedGroups),
    [streamingEntries, expandedGroups],
  )
  const virtualEntries = useMemo(
    () => [...historicalVirtualEntries, ...streamingVirtualEntries],
    [historicalVirtualEntries, streamingVirtualEntries],
  )
  const latestEntry = virtualEntries.at(-1)
  const {
    registerRow,
    scrollRef: listRef,
    window: messageWindow,
  } = useSlidingWindow({
    total: virtualEntries.length,
    storedWindow,
    setStoredWindow: setMessageWindow,
    latestVersion: latestEntry
      ? `${virtualEntryVersion(latestEntry)}:${run?.runId ?? ''}:${run?.status ?? ''}`
      : '',
  })
  const visibleEntries = virtualEntries.slice(messageWindow.start, messageWindow.end)

  if (historicalEntries.length === 0 && streamingEntries.length === 0) {
    return <div className="agentnew-message-empty">开始对话吧</div>
  }

  return (
    <div ref={listRef} className="agentnew-message-list">
      {visibleEntries.map((entry) => {
          let content: ReactNode
          if (entry.kind === 'thinking-header') {
            const expanded = expandedGroups[entry.sortKey] !== false
            const stepCount = entry.group.entries.length
            content = (
              <section className={`agentnew-thinking-group${expanded ? ' is-open' : ''}`}>
                <button
                  type="button"
                  className="agentnew-thinking-toggle"
                  aria-label={`${expanded ? '收起' : '展开'}思考过程，共 ${stepCount} 步`}
                  aria-expanded={expanded}
                  onClick={() => setExpandedGroups((current) => ({
                    ...current,
                    [entry.sortKey]: !expanded,
                  }))}
                >
                  <span className="agentnew-thinking-summary-content">
                    <span className="agentnew-thinking-mark" aria-hidden="true">✦</span>
                    <span className="agentnew-thinking-heading">
                      <strong>思考过程</strong>
                      <small>{stepCount} 个步骤</small>
                    </span>
                    <span className="agentnew-thinking-action" aria-hidden="true">
                      {expanded ? '收起' : '展开'}
                    </span>
                    <svg
                      className="agentnew-thinking-chevron"
                      aria-hidden="true"
                      viewBox="0 0 16 16"
                    >
                      <path d="m4 6 4 4 4-4" />
                    </svg>
                  </span>
                </button>
              </section>
            )
          } else if (entry.kind === 'thinking-step-row') {
            content = (
              <div className="agentnew-thinking-step-row">
                <ThinkingStep entry={entry.entry} />
              </div>
            )
          } else if (entry.kind === 'card') {
            content = <BrowserActionCard card={entry.card} />
          } else {
            const { ci } = entry
            const { item } = ci
            const isUser = item.role === 'user'
            const checkpointTurn = isUser
              ? checkpointTurnByUserItemId.get(ci.id)
              : undefined
            const isStreaming = ci.pending === true
            const className = [
              'agentnew-msg',
              isUser ? 'agentnew-msg--user' : 'agentnew-msg--assistant',
              isStreaming ? 'agentnew-msg--streaming' : '',
            ].filter(Boolean).join(' ')
            const message = (
              <div className={className}>
                <MessageMarkdown>{item.role === 'assistant' || item.role === 'user' ? item.content ?? '' : ''}</MessageMarkdown>
                {isStreaming ? <span className="agentnew-stream-caret" aria-label="正在生成" /> : null}
              </div>
            )
            content = isUser ? (
              <div className="agentnew-user-message">
                {message}
                {checkpointTurn !== undefined ? (
                  <button
                    type="button"
                    className="agentnew-message-revert"
                    aria-label={`回退到第 ${checkpointTurn + 1} 轮之前`}
                    title="撤回此消息及之后的对话，并将原输入放回输入框"
                    onClick={() => revertTurnToDraft(checkpointTurn)}
                  >
                    <span aria-hidden="true">↶</span>
                    回退
                  </button>
                ) : null}
              </div>
            ) : message
          }
          return (
            <SlidingWindowRow
              key={entry.sortKey}
              rowKey={entry.sortKey}
              register={registerRow}
            >
              {content}
            </SlidingWindowRow>
          )
        })}
      {messageWindow.end >= virtualEntries.length
        ? <RunDurationStatus items={items} run={run} />
        : null}
    </div>
  )
}
