import { useState } from 'react'
import { useAtomValue, useStore } from '@einfach/react'
import {
  activePendingArtifactsAtom,
  activeSessionIdAtom,
  removePendingArtifact,
  type PendingArtifact,
} from '../agent/state/atoms'

type SaveStatus = { kind: 'idle' | 'saving' | 'cancelled' | 'error'; message?: string }

interface SaveFilePickerWindow {
  showSaveFilePicker?: (options?: {
    suggestedName?: string
    types?: Array<{ description?: string; accept: Record<string, string[]> }>
  }) => Promise<{
    createWritable: () => Promise<{
      write: (data: BlobPart) => Promise<void>
      close: () => Promise<void>
    }>
  }>
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

function hasSaveFilePicker(): boolean {
  // PF5: feature-detect by callability, not merely presence — `'x' in window`
  // is true even if the slot holds a non-function value.
  return typeof (window as unknown as SaveFilePickerWindow).showSaveFilePicker === 'function'
}

async function saveViaFilePicker(artifact: PendingArtifact) {
  const picker = (window as unknown as SaveFilePickerWindow).showSaveFilePicker!
  const mimeType = artifact.mimeType || 'text/plain'
  const handle = await picker({
    suggestedName: artifact.filename,
    types: [{ description: '文件', accept: { [mimeType]: [extensionOf(artifact.filename)] } }],
  })

  // createWritable / write / close. Always close the stream so we never leak the
  // writable handle — but PF5: if close() also throws, do NOT let it mask the
  // original write error (which is what the user needs to see).
  const writable = await handle.createWritable()
  let writeError: unknown
  try {
    await writable.write(new Blob([artifact.content], { type: mimeType }))
  } catch (error) {
    writeError = error
  } finally {
    try {
      await writable.close()
    } catch (closeError) {
      // Only surface a close failure when the write itself succeeded; otherwise
      // keep the original write error.
      if (!writeError) writeError = closeError
    }
  }
  if (writeError) throw writeError
}

function saveViaBlobLink(artifact: PendingArtifact) {
  const mimeType = artifact.mimeType || 'text/plain'
  const url = URL.createObjectURL(new Blob([artifact.content], { type: mimeType }))
  const link = document.createElement('a')
  link.href = url
  link.download = artifact.filename
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function extensionOf(filename: string) {
  const dot = filename.lastIndexOf('.')
  return dot >= 0 ? filename.slice(dot) : '.txt'
}

function ArtifactRow({ artifact, ownerSessionId }: { artifact: PendingArtifact; ownerSessionId: string }) {
  const store = useStore()
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' })

  const handleSave = async () => {
    // PF4: capture the owning session NOW, at click time. The picker/write is
    // async; the active session may change before it resolves, so we must remove
    // the artifact from the session it belongs to — never from "current active".
    const sessionId = ownerSessionId
    setStatus({ kind: 'saving' })
    try {
      // Feature-detect File System Access (PF5: by callability); gracefully
      // degrade to a download link on browsers that lack showSaveFilePicker.
      if (hasSaveFilePicker()) {
        await saveViaFilePicker(artifact)
      } else {
        saveViaBlobLink(artifact)
      }
      removePendingArtifact(store, artifact.id, sessionId)
    } catch (error) {
      if (isAbortError(error)) {
        // User dismissed the picker — friendly, non-destructive, keep the artifact.
        setStatus({ kind: 'cancelled', message: '已取消保存。' })
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      setStatus({ kind: 'error', message: `保存失败：${message}` })
    }
  }

  return (
    <div className="save-artifact-row agent-save-artifact-row">
      <div className="save-artifact-info agent-save-artifact-info">
        <span className="save-artifact-name agent-save-artifact-name">{artifact.filename}</span>
        <span className="save-artifact-meta agent-save-artifact-meta">{artifact.content.length} 字符</span>
        {status.kind === 'cancelled' && (
          <span className="save-artifact-hint agent-save-artifact-hint">{status.message}</span>
        )}
        {status.kind === 'error' && (
          <span className="save-artifact-error agent-save-artifact-error">{status.message}</span>
        )}
      </div>
      <button
        type="button"
        className="secondary-button save-artifact-button agent-save-artifact-button"
        disabled={status.kind === 'saving'}
        onClick={() => {
          void handleSave()
        }}
      >
        💾 保存
      </button>
    </div>
  )
}

export function SaveArtifact() {
  const artifacts = useAtomValue(activePendingArtifactsAtom)
  const sessionId = useAtomValue(activeSessionIdAtom)
  if (!artifacts.length) return null

  return (
    <section className="save-artifact agent-save-artifact" aria-label="待保存文件">
      <div className="save-artifact-title agent-save-artifact-title">待保存文件</div>
      {artifacts.map((artifact) => (
        <ArtifactRow key={artifact.id} artifact={artifact} ownerSessionId={sessionId} />
      ))}
    </section>
  )
}
