// 待保存文件卡片（P8-f）——把 save_file 暂存的产物落盘到用户磁盘。
// ---------------------------------------------------------------------------
// 契约：
//   · U1：UI 只做两件事 —— 读 atom（pendingArtifactsAtom）+ 调命令（discardArtifact）。
//     绝不 import transient writer removePendingArtifact、绝不碰会话 store 实例 / setter。
//   · U3 + PF4/R3：ownerSessionId 必须在「点击那一刻」用 rootStore.getter(activeSessionIdAtom)
//     捕获——保存是异步（picker/write），active 可能在异步期间被切走，删产物要删「归属会话」
//     而不是「完成时的当前 active」。activeSessionIdAtom 住在 rootStore，不能在会话 Provider 下
//     useAtomValue 它，所以走 rootStore.getter 显式取。
// 保存逻辑照搬旧 src/chat/SaveArtifact：File System Access 优先（可调用检测）、blob-link 降级、
// close 不掩盖 write 错、AbortError=用户取消（保留产物、提示「已取消保存」）。

import { useState } from 'react'
import { useAgentAtomValue } from '@einfach-agent/react-plugin'
import {
  pendingArtifactsAtom,
  type PendingArtifact,
  rootStore,
  activeSessionIdAtom,
  discardArtifact,
} from '@einfach-agent/core'

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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function hasSaveFilePicker(): boolean {
  // 特性检测按「可调用」判断，而不是 `'x' in window` —— 后者哪怕槽位是非函数值也为真。
  return typeof (window as unknown as SaveFilePickerWindow).showSaveFilePicker === 'function'
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot >= 0 ? filename.slice(dot) : '.txt'
}

async function saveViaFilePicker(artifact: PendingArtifact): Promise<void> {
  const picker = (window as unknown as SaveFilePickerWindow).showSaveFilePicker!
  const mimeType = artifact.mimeType || 'text/plain'
  const handle = await picker({
    suggestedName: artifact.filename,
    types: [{ description: '文件', accept: { [mimeType]: [extensionOf(artifact.filename)] } }],
  })

  // createWritable / write / close：始终关闭 writable 以免泄漏句柄；但 close() 若也抛错，
  // 不能掩盖原始 write 错（用户真正需要看到的是 write 那个）。
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
      // 只有 write 本身成功时才让 close 错冒头；否则保留原始 write 错。
      if (!writeError) writeError = closeError
    }
  }
  if (writeError) throw writeError
}

function saveViaBlobLink(artifact: PendingArtifact): void {
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

function ArtifactRow({ artifact }: { artifact: PendingArtifact }) {
  const [status, setStatus] = useState<SaveStatus>({ kind: 'idle' })

  const handleSave = async () => {
    // PF4/R3：此刻（点击瞬间）捕获归属会话。picker/write 是异步，active 可能在期间被切走，
    // 保存成功后要从「产物归属的会话」删除，而不是异步完成时的当前 active。
    const ownerSessionId = rootStore.getter(activeSessionIdAtom)
    setStatus({ kind: 'saving' })
    try {
      // 特性检测 File System Access（按可调用检测）；缺失则优雅降级为 blob 下载链接。
      if (hasSaveFilePicker()) {
        await saveViaFilePicker(artifact)
      } else {
        saveViaBlobLink(artifact)
      }
      // U1：走命令而非直接 import writer removePendingArtifact。
      discardArtifact(ownerSessionId, artifact.id)
    } catch (error) {
      if (isAbortError(error)) {
        // 用户在 picker 里取消——友好提示、不破坏、保留产物。
        setStatus({ kind: 'cancelled', message: '已取消保存。' })
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      setStatus({ kind: 'error', message: `保存失败：${message}` })
    }
  }

  return (
    <div className="agentnew-save-artifact-row">
      <div className="agentnew-save-artifact-info">
        <span className="agentnew-save-artifact-name">{artifact.filename}</span>
        <span className="agentnew-save-artifact-meta">{artifact.content.length} 字符</span>
        {status.kind === 'cancelled' && (
          <span className="agentnew-save-artifact-hint">{status.message}</span>
        )}
        {status.kind === 'error' && (
          <span className="agentnew-save-artifact-error">{status.message}</span>
        )}
      </div>
      <button
        type="button"
        className="agentnew-save-artifact-button"
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
  // U3：经 agent store 读 —— 拿到的是该会话的待保存产物。
  const artifacts = useAgentAtomValue(pendingArtifactsAtom)
  if (!artifacts.length) return null

  return (
    <section className="agentnew-save-artifact" aria-label="待保存文件">
      <div className="agentnew-save-artifact-title">待保存文件</div>
      {artifacts.map((artifact) => (
        <ArtifactRow key={artifact.id} artifact={artifact} />
      ))}
    </section>
  )
}
