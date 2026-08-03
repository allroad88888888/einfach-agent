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
} from '@web-agent/core/state/transientAtoms'
import {
  isTimelineThinkingItem,
  projectTimelineItems,
} from '@web-agent/core/timeline'
import {
  messageWindowAtom,
} from './messageWindowModel'
import { RunDurationStatus } from './RunDurationStatus'
import { TimelineItemView } from './TimelineItemView'
import {
  flattenTimelineVirtualEntries,
  groupTimelineThinkingEntries,
  timelineVirtualEntryVersion,
  type TimelineRenderEntry,
} from './messageTimelineViewModel'
import { SlidingWindowRow, useSlidingWindow } from './useSlidingWindow'
import { useWebTimelineRendererRegistry } from './WebTimelineRendererRegistryProvider'

export function MessageList() {
  const items = useAtomValue(itemsAtom)
  const run = useAtomValue(runAtom)
  const assistantStream = useAtomValue(assistantStreamAtom)
  const checkpoints = useAtomValue(checkpointsAtom)
  const cards = useAtomValue(browserCardsAtom)
  const runtimeEvents = useAtomValue(runtimeTranscriptEventsAtom)
  const [expandedGroups, setExpandedGroups] = useAtom(expandedTranscriptGroupsAtom)
  const [storedWindow, setMessageWindow] = useAtom(messageWindowAtom)
  const timelineRendererRegistry = useWebTimelineRendererRegistry()
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

  const historicalVirtualEntries = useMemo(
    () => flattenTimelineVirtualEntries(historicalEntries, expandedGroups),
    [historicalEntries, expandedGroups],
  )
  const streamingVirtualEntries = useMemo(
    () => flattenTimelineVirtualEntries(streamingEntries, expandedGroups),
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
      ? `${timelineVirtualEntryVersion(latestEntry)}:${run?.runId ?? ''}:${run?.status ?? ''}`
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
              <TimelineItemView item={entry.entry} registry={timelineRendererRegistry} />
            </div>
          )
        } else {
          const renderedItem = <TimelineItemView item={entry} registry={timelineRendererRegistry} />
          if (entry.kind !== 'message') {
            content = renderedItem
          } else {
            const ci = entry.conversationItem
            const isUser = ci.item.role === 'user'
            const checkpointTurn = isUser
              ? checkpointTurnByUserItemId.get(ci.id)
              : undefined
            content = isUser ? (
              <div className="agentnew-user-message">
                {renderedItem}
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
      {messageWindow.end >= virtualEntries.length
        ? <RunDurationStatus items={items} run={run} />
        : null}
    </div>
  )
}
