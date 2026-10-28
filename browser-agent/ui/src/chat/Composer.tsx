import { useLayoutEffect, useRef, useState, type FormEvent, type RefObject } from 'react'
import { addTextAttachments, TEXT_ATTACHMENT_ACCEPT, type TextAttachment } from '@einfach-agent/browser-agent'

interface ComposerProps {
  draft: string
  files: readonly TextAttachment[]
  disabled: boolean
  blocked: boolean
  submitting: boolean
  textareaRef: RefObject<HTMLTextAreaElement>
  onDraft(value: string): void
  onFiles(files: TextAttachment[]): void
  onError(message: string): void
  onSubmit(event: FormEvent): void
}

export function Composer({ draft, files, disabled, blocked, submitting, textareaRef, onDraft, onFiles, onError, onSubmit }: ComposerProps) {
  const picker = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  useLayoutEffect(() => {
    const area = textareaRef.current
    if (!area) return
    area.style.height = 'auto'
    area.style.height = `${Math.min(128, Math.max(40, area.scrollHeight))}px`
  }, [draft, textareaRef])
  function attach(selected: File[]) {
    if (disabled || !selected.length) return
    try { onFiles(addTextAttachments(files, selected)); onError(''); textareaRef.current?.focus() }
    catch (error) { onError(error instanceof Error ? error.message : '无法添加附件。') }
  }
  return <form className={`bav-composer${dragging ? ' is-dragging' : ''}`} onSubmit={onSubmit}
    onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'; if (!disabled) setDragging(true) } }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
    onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); setDragging(false); attach(Array.from(event.dataTransfer.files)) } }}>
    <input ref={picker} type="file" hidden multiple accept={TEXT_ATTACHMENT_ACCEPT} aria-label="选择附件" disabled={disabled}
      onChange={(event) => { attach(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = '' }} />
    {files.length > 0 && <ul className="bav-attachment-tray" aria-label="待发送附件">{files.map((file) => <li key={file.id}>
      <span className="bav-file-badge" aria-hidden="true">{file.name.split('.').pop()?.slice(0, 4).toUpperCase()}</span>
      <span className="bav-file-info"><strong title={file.name}>{file.name}</strong><small>{fileSize(file.byteSize)}</small></span>
      <button type="button" className="bav-remove-attachment" aria-label={`移除附件 ${file.name}`} title="移除附件" disabled={disabled} onClick={() => { onFiles(files.filter((item) => item.id !== file.id)); textareaRef.current?.focus() }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg></button>
    </li>)}</ul>}
    <div className="bav-composer-row">
      <button type="button" className="bav-attach-button" aria-label="添加附件" title="添加附件 · PDF/图片最多 20 MB，文本最多 256 KB" disabled={disabled} onClick={() => picker.current?.click()}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 13 6.3-6.3a3.2 3.2 0 0 1 4.5 4.5L10 20a5.3 5.3 0 0 1-7.5-7.5L12 3a2 2 0 0 1 2.8 2.8l-9 9a1.2 1.2 0 0 0 1.7 1.7l8.7-8.7" /></svg></button>
      <textarea ref={textareaRef} rows={1} aria-label="消息" placeholder="输入消息…" value={draft} onChange={(event) => onDraft(event.target.value)} disabled={disabled}
        onPaste={(event) => { if (event.clipboardData.files.length) { event.preventDefault(); attach(Array.from(event.clipboardData.files)) } }}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} />
      <button type="submit" className="bav-send-button" aria-label={submitting ? '正在准备附件' : '发送'} title="发送 · Enter" disabled={disabled || blocked || (!draft.trim() && !files.length)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg></button>
    </div>
  </form>
}

function fileSize(bytes: number): string { return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : bytes < 1024 ? `${bytes} B` : `${Math.ceil(bytes / 1024)} KB` }
