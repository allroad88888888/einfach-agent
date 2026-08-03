// Core 浏览器卡片时间线 item 的默认 Web 呈现。

import type { TimelineBrowserCardItem } from '@web-agent/core/timeline'
import { BrowserActionCard } from './BrowserActionCard'

export function BrowserCardTimelineRenderer({ item }: { readonly item: TimelineBrowserCardItem }) {
  return <BrowserActionCard card={item.card} />
}
