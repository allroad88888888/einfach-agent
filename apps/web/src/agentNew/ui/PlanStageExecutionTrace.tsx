// 计划阶段的虚拟化执行轨迹。

import { useAtom } from '@einfach/react'
import { useCallback } from 'react'
import type { TimelineThinkingItem } from '@einfach-agent/core/timeline'
import { planTraceWindowsAtom } from './messageWindowModel'
import { TimelineItemView } from './TimelineItemView'
import { SlidingWindowRow, useSlidingWindow } from './useSlidingWindow'
import { useWebTimelineRendererRegistry } from './WebTimelineRendererRegistryProvider'

export function PlanStageExecutionTrace({
  windowId,
  stageId,
  entries = [],
}: {
  windowId: string
  stageId: string
  entries?: TimelineThinkingItem[]
}) {
  const registry = useWebTimelineRendererRegistry()
  const [traceWindows, setTraceWindows] = useAtom(planTraceWindowsAtom)
  const storedWindow = traceWindows[windowId] ?? { start: 0, end: 0, direction: 'idle' }
  const setStoredWindow = useCallback((next: typeof storedWindow) => {
    setTraceWindows((current) => ({ ...current, [windowId]: next }))
  }, [setTraceWindows, windowId])
  const latestEntry = entries.at(-1)
  const { registerRow, scrollRef, window: traceWindow } = useSlidingWindow({
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
        <div ref={scrollRef} className="agentnew-thinking-steps agentnew-plan-stage-trace-window">
          {visibleEntries.map((entry) => (
            <SlidingWindowRow
              key={entry.sortKey}
              rowKey={entry.sortKey}
              register={registerRow}
              className="agentnew-plan-trace-row"
            >
              <TimelineItemView item={entry} registry={registry} />
            </SlidingWindowRow>
          ))}
        </div>
      ) : <span className="agentnew-plan-stage-trace-empty">尚无模型思考或工具调用</span>}
    </section>
  )
}
