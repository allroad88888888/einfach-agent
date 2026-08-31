import { useRef } from 'react'
import { useLingui } from '@lingui/react/macro'
import { useAtomValue, useSetAtom } from '@einfach/react'
import type { ImageInputCapability } from '@einfach-agent/ai'
import {
  composerImageAttachmentAtom,
  removeComposerImageAttachmentAtom,
} from './composerImageAttachmentState'
import { ComposerAttachmentPreview } from './ComposerAttachmentPreview'
import './ComposerAttachmentTray.css'

function formatBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

export function ComposerAttachmentTray({
  capability,
  disabled,
  onFiles,
}: {
  readonly capability: ImageInputCapability
  readonly disabled: boolean
  readonly onFiles: (files: readonly File[]) => void
}) {
  const { t } = useLingui()
  const inputRef = useRef<HTMLInputElement>(null)
  const attachments = useAtomValue(composerImageAttachmentAtom)
  const remove = useSetAtom(removeComposerImageAttachmentAtom)
  const supported = capability.kind === 'provider-upload'
  const busy = attachments.operation !== 'idle'

  return (
    <div className="agentnew-composer-attachments">
      {attachments.images.length > 0 ? (
        <ul className="agentnew-composer-image-list" aria-label={t`待发送图片`}>
          {attachments.images.map((image) => (
            <li key={image.id} className="agentnew-composer-image-item">
              <ComposerAttachmentPreview file={image.file} alt={image.name} />
              <span className="agentnew-composer-image-name">{image.name}</span>
              <span className="agentnew-composer-image-meta">{image.width} × {image.height} · {formatBytes(image.byteSize)}</span>
              <button
                type="button"
                className="agentnew-composer-image-remove"
                aria-label={t`移除图片：${image.name}`}
                disabled={disabled || busy}
                onClick={() => remove(image.id)}
              >
                {t`移除`}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {attachments.operation === 'validating' ? <span role="status">{t`正在检查图片…`}</span> : null}
      {attachments.operation === 'submitting' ? <span role="status">{t`正在准备图片…`}</span> : null}
      {attachments.error ? <div role="alert">{attachments.error}</div> : null}
      <input
        ref={inputRef}
        className="agentnew-composer-image-input"
        type="file"
        accept={supported ? capability.accept.join(',') : undefined}
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          onFiles(Array.from(event.target.files ?? []))
          event.target.value = ''
        }}
      />
      <button
        type="button"
        className="agentnew-composer-add-image"
        disabled={disabled || busy || !supported}
        title={supported ? t`添加图片（也可粘贴或拖放）` : capability.reason}
        onClick={() => inputRef.current?.click()}
      >
        {t`添加图片`}
      </button>
      {!supported ? <span className="agentnew-composer-image-unsupported">{t`当前模型不支持图片输入`}</span> : null}
    </div>
  )
}
