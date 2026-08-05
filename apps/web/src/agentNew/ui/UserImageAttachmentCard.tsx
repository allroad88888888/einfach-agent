import type { UserImageContentBlock } from '@web-agent/ai'
import { useHistoryImageProjection } from './HistoryImageCompatibilityContext'
import './UserImageAttachmentCard.css'

function formatBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

/** Renders persisted, trace-safe metadata only; provider file references stay hidden. */
export function UserImageAttachmentCard({ image }: { readonly image: UserImageContentBlock }) {
  const projection = useHistoryImageProjection(image)
  const metadata = projection.kind === 'consumable' ? projection.image : projection.metadata
  const dimensions = metadata.width && metadata.height
    ? ` · ${metadata.width} × ${metadata.height}`
    : ''
  if (projection.kind === 'placeholder') {
    return (
      <div
        className="agentnew-user-image-card is-unavailable"
        role="group"
        aria-label={`历史图片不可用：${metadata.name}`}
      >
        <span aria-hidden="true">图片不可用</span>
        <strong>{metadata.name}</strong>
        <span>当前模型无法使用这张历史图片</span>
      </div>
    )
  }
  return (
    <div className="agentnew-user-image-card" role="group" aria-label={`已发送图片：${metadata.name}`}>
      <span aria-hidden="true">图片</span>
      <strong>{metadata.name}</strong>
      <span>{metadata.mimeType} · {formatBytes(metadata.byteSize)}{dimensions}</span>
    </div>
  )
}
