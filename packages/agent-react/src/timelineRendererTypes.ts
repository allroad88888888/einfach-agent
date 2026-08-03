// 时间线 renderer 的类型映射：将 Core item kind 精确关联到它可接收的 React props。

import type { ComponentType } from 'react'
import type { TimelineItem } from '@web-agent/core/timeline'

export type TimelineItemKind = TimelineItem['kind']

export type TimelineItemFor<K extends TimelineItemKind> = Extract<TimelineItem, { kind: K }>

export type TimelineRenderer<K extends TimelineItemKind = TimelineItemKind> = ComponentType<{
  readonly item: TimelineItemFor<K>
}>

export type TimelineRendererMap = {
  readonly [K in TimelineItemKind]: TimelineRenderer<K>
}

export type BuiltInTimelineRenderers = Readonly<Partial<TimelineRendererMap>>

export interface TimelineRendererRegistry {
  register<K extends TimelineItemKind>(kind: K, renderer: TimelineRenderer<K>): () => void
  resolve<K extends TimelineItemKind>(kind: K): TimelineRenderer<K> | undefined
  resolve(kind: string): TimelineRenderer | undefined
}

export interface TimelineRendererRegistryOptions {
  /** 宿主构造期写入并锁定的 Core 内建 renderer；第三方不可覆盖。 */
  readonly builtInRenderers?: BuiltInTimelineRenderers
}
