// 将一个 Core 时间线条目委派给当前 React root 的 renderer，缺失时安全降级。

import type { TimelineItem } from '@web-agent/core/timeline'
import {
  UnknownTimelineItem,
  type TimelineRendererRegistry,
} from '@web-agent/react-plugin'

export function TimelineItemView({
  item,
  registry,
}: {
  readonly item: TimelineItem
  readonly registry: TimelineRendererRegistry
}) {
  const Renderer = registry.resolve(item.kind)
  return Renderer
    ? <Renderer item={item} />
    : <UnknownTimelineItem item={item} />
}
