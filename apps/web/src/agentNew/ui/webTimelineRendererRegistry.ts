// 创建 Web 根持有的默认 timeline renderer registry；内建 Core kind 在构造时锁定。

import {
  createTimelineRendererRegistry,
  type BuiltInTimelineRenderers,
  type TimelineRendererRegistry,
} from '@web-agent/react-plugin'
import { BrowserCardTimelineRenderer } from './BrowserCardTimelineRenderer'
import { MessageTimelineRenderer } from './MessageTimelineRenderer'
import {
  ReasoningTimelineRenderer,
  RuntimeEventTimelineRenderer,
  ThinkingMessageTimelineRenderer,
  ToolExecutionTimelineRenderer,
} from './ThinkingTimelineRenderers'

const builtInRenderers = {
  message: MessageTimelineRenderer,
  reasoning: ReasoningTimelineRenderer,
  'thinking-message': ThinkingMessageTimelineRenderer,
  'tool-execution-group': ToolExecutionTimelineRenderer,
  'runtime-event': RuntimeEventTimelineRenderer,
  card: BrowserCardTimelineRenderer,
} satisfies BuiltInTimelineRenderers

export function createWebTimelineRendererRegistry(): TimelineRendererRegistry {
  return createTimelineRendererRegistry({ builtInRenderers })
}
