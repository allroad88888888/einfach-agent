// 右栏消息列表（P-U3 / P8-g）——在「当前会话 store」的 Provider 下，
// 读 itemsAtom + browserCardsAtom + runtimeTranscriptEventsAtom，把助手回复、工具调用/结果、
// 运行时注入事件与浏览器卡片按时间合并渲染。
// ---------------------------------------------------------------------------
// 契约（U1）：会话状态经 useAgentAtomValue 只读（值在 agent store）；思考组展开与消息窗口是
// 渲染态，住 UI store，直接写。用户消息的回退入口只调用命令，不碰 store / writer。
// 可见性规则：
//   · user：渲染为右侧消息气泡；
//   · assistant：reasoning_content 归入思考过程；最终 content 渲染文本气泡；
//     带 tool_calls 的中间 content 作为执行说明归入思考过程；
//   · tool：通过 tool_call_id 合并进对应工具调用卡片；
//   · runtime transcript event / 工具执行：连续项合并为默认展开的思考过程；
//   · system ConversationItem：仍然不渲染，避免把异常入库的 system 当成正常 transcript。

import { useAtom, useSetAtom } from '@einfach/react'
import {
  useMemo,
  type ReactNode,
} from 'react'
import { useAgentAtomValue } from '@einfach-agent/react-plugin'
import { Trans, useLingui } from '@lingui/react/macro'
import {
  itemsAtom,
  planAtom,
  runAtom,
  assistantStreamAtom,
  browserCardsAtom,
  runtimeTranscriptEventsAtom,
  retractTurn,
} from '@einfach-agent/core'
import { userMessageText } from '@einfach-agent/ai'
import {
  isTimelineThinkingItem,
  projectTimelineItems,
} from '@einfach-agent/core/timeline'
import { expandedTranscriptGroupsAtom } from './transcriptViewState'
import { composerDraftAtom } from './composerDraftState'
import {
  messageWindowAtom,
} from './messageWindowModel'
import { RunDurationStatus } from './RunDurationStatus'
import { CompletedPlanRecord } from './CompletedPlanRecord'
import { TimelineItemView } from './TimelineItemView'
import {
  flattenTimelineVirtualEntries,
  groupTimelineThinkingEntries,
  insertCompletedPlanRecord,
  timelineVirtualEntryVersion,
  type TimelineRenderEntry,
} from './messageTimelineViewModel'
import { SlidingWindowRow, useSlidingWindow } from './useSlidingWindow'
import { useWebTimelineRendererRegistry } from './WebTimelineRendererRegistryProvider'

export function MessageList() {
  const { t } = useLingui()
  const items = useAgentAtomValue(itemsAtom)
  const run = useAgentAtomValue(runAtom)
  const plan = useAgentAtomValue(planAtom)
  const assistantStream = useAgentAtomValue(assistantStreamAtom)
  const cards = useAgentAtomValue(browserCardsAtom)
  const runtimeEvents = useAgentAtomValue(runtimeTranscriptEventsAtom)
  const [expandedGroups, setExpandedGroups] = useAtom(expandedTranscriptGroupsAtom)
  const [storedWindow, setMessageWindow] = useAtom(messageWindowAtom)
  const setComposerDraft = useSetAtom(composerDraftAtom)
  const timelineRendererRegistry = useWebTimelineRendererRegistry()
  const streamedItemId = assistantStream?.item.id

  // 流式占位条目也在 itemsAtom 中，但正文更新只走 assistantStreamAtom。历史索引排除占位，
  // 让每个 delta 只重算当前这一条消息，不扫描整段会话。
  const historicalItems = useMemo(
    () => streamedItemId ? items.filter((item) => item.id !== streamedItemId) : items,
    [items, streamedItemId],
  )

  const historicalEntries = useMemo<TimelineRenderEntry[]>(() => {
    const merged = projectTimelineItems({
      conversationItems: historicalItems,
      runtimeEvents,
      browserCards: cards,
    }).filter((entry) => (
      !entry.planStageId ||
      entry.kind !== 'message' ||
      entry.conversationItem.item.role !== 'assistant'
    )).filter((entry) => !entry.planStageId || !isTimelineThinkingItem(entry))
    return groupTimelineThinkingEntries(merged)
  }, [cards, historicalItems, runtimeEvents])

  const streamingEntries = useMemo<TimelineRenderEntry[]>(() => {
    const ci = assistantStream?.item
    if (!ci) return []
    const merged = projectTimelineItems({
      conversationItems: [ci],
      conversationItemIndexOffset: historicalItems.length,
    })
      .filter((entry) => (
        !ci.planStageId ||
        entry.kind !== 'message' ||
        entry.conversationItem.item.role !== 'assistant'
      ))
      .filter((entry) => !ci.planStageId || !isTimelineThinkingItem(entry))
    return groupTimelineThinkingEntries(merged)
  }, [assistantStream, historicalItems.length])

  const virtualEntries = useMemo(
    () => flattenTimelineVirtualEntries(
      insertCompletedPlanRecord([...historicalEntries, ...streamingEntries], plan),
      expandedGroups,
    ),
    [historicalEntries, streamingEntries, expandedGroups, plan],
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
      ? `${timelineVirtualEntryVersion(latestEntry)}:${run?.runId ?? ''}:${run?.status ?? ''}`
      : '',
  })
  const visibleEntries = virtualEntries.slice(messageWindow.start, messageWindow.end)

  if (virtualEntries.length === 0) {
    return (
      <div ref={listRef} className="agentnew-message-list">
        <div className="agentnew-message-empty"><Trans>开始对话吧</Trans></div>
      </div>
    )
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
                aria-label={expanded
                  ? t`收起思考过程，共 ${stepCount} 步`
                  : t`展开思考过程，共 ${stepCount} 步`}
                aria-expanded={expanded}
                onClick={() => setExpandedGroups((current) => ({
                  ...current,
                  [entry.sortKey]: !expanded,
                }))}
              >
                <span className="agentnew-thinking-summary-content">
                  <span className="agentnew-thinking-mark" aria-hidden="true">✦</span>
                  <span className="agentnew-thinking-heading">
                    <strong><Trans>思考过程</Trans></strong>
                    <small><Trans>{stepCount} 个步骤</Trans></small>
                  </span>
                  <span className="agentnew-thinking-action" aria-hidden="true">
                    {expanded ? <Trans>收起</Trans> : <Trans>展开</Trans>}
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
              <TimelineItemView item={entry.entry} registry={timelineRendererRegistry} />
            </div>
          )
        } else if (entry.kind === 'completed-plan-record') {
          content = <CompletedPlanRecord />
        } else {
          const renderedItem = <TimelineItemView item={entry} registry={timelineRendererRegistry} />
          if (entry.kind !== 'message') {
            content = renderedItem
          } else {
            const ci = entry.conversationItem
            const isUser = ci.item.role === 'user'
            const userText = ci.item.role === 'user' ? userMessageText(ci.item.content) : ''
            content = isUser ? (
              <div className="agentnew-user-message">
                {renderedItem}
                <button
                  type="button"
                  className="agentnew-message-revert"
                  aria-label={t`撤回本轮对话`}
                  title={run?.status === 'running' || run?.status === 'awaiting_tool'
                    ? t`停止当前运行并撤回此消息之后的对话`
                    : t`撤回此消息及其后的对话`}
                  onClick={() => {
                    const result = retractTurn(ci.id)
                    if (!result.ok) return
                    setComposerDraft(userText)
                    document.getElementById('agentnew-composer-input')?.focus()
                  }}
                >
                  <span aria-hidden="true">↶</span>
                  <Trans>撤回</Trans>
                </button>
              </div>
            ) : renderedItem
          }
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
      {messageWindow.end >= virtualEntries.length ? (
        <RunDurationStatus items={items} run={run} />
      ) : null}
    </div>
  )
}
