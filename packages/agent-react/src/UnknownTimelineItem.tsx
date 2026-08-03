// 未被当前 React root 识别的 timeline kind 的安全纯文本 fallback。

export interface UnknownTimelineItemProps {
  readonly item: {
    readonly id: string
    readonly kind: string
  }
}

/** 只显示 kind 文本；不读取或解释未知 item 的其余 payload。 */
export function UnknownTimelineItem({ item }: UnknownTimelineItemProps) {
  return <div role="status">Unsupported timeline item: {item.kind}</div>
}
