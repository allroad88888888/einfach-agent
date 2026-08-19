// 生命周期探针 UI 插件的 reasoning renderer；只消费公开时间线投影。

import type { TimelineItemFor } from '@einfach-agent/react-plugin'

export function LifecycleProbeReasoningRenderer({
  item,
}: {
  readonly item: TimelineItemFor<'reasoning'>
}) {
  return (
    <section data-testid="lifecycle-probe-reasoning">
      <strong>Lifecycle probe reasoning</strong>
      <p>{item.content}</p>
    </section>
  )
}
