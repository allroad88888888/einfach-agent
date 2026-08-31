import { atom } from '@einfach/react'
import type { ImageInputCapability } from '@einfach-agent/ai'
import { msg } from '@lingui/core/macro'
import { translateMessage } from '../../i18n/translateMessage'
import {
  inspectStaticImage,
  StaticImagePolicyError,
} from '../../imageInput/staticImagePolicy'

export interface ComposerImageAttachment {
  readonly id: string
  readonly file: File
  readonly name: string
  readonly mimeType: string
  readonly byteSize: number
  readonly width: number
  readonly height: number
}

export interface ComposerImageAttachmentState {
  readonly images: readonly ComposerImageAttachment[]
  readonly operation: 'idle' | 'validating' | 'submitting'
  readonly error?: string
  readonly revision: number
}

/**
 * 输入框里待发送的图片附件。
 *
 * 它住**界面 store**（`apps/web/src/uiStore.ts`），刷新即丢，切会话由
 * `sessionScopedViewState.ts` 清掉。同一个输入框里的文字草稿同样如此 —— 两者都不进恢复快照，
 * 这是明确裁决，不是遗漏。下面这段记录的是「就算将来想让它进快照，也不能直接补一行槽位」。
 *
 * **丢的是什么**：只有**粘贴来源**的图。三条入口里，拖拽（`Composer.tsx` 的 `onDrop`）和
 * 选文件（`ComposerAttachmentTray` 的 `<input type="file">`）拿到的 `File` 在磁盘上有第二份，
 * 用户重选一次即可；而 `onPaste` 直接吃 `event.clipboardData.files`（截图粘贴就是这条路），
 * 那些字节在磁盘、transcript、快照里**都没有第二份** —— 刷新或崩溃就是永久丢失。
 *
 * **为什么这不是「忘了登记」而是结构性障碍**：槽位值必须过得了快照投影那一步的 JSON round-trip
 * （`state/recoveryProjection.ts` 的 `jsonClone` = `JSON.parse(JSON.stringify(...))`）。`File`
 * 过不去，而且**不是抛错、是静默变成 `{}`**：字节没了，形状还在，恢复出来是一堆 0 字节的空附件，
 * 比不恢复更坏。要真正修，得先把粘贴的字节落到一个可寻址的地方（磁盘暂存或 provider 上传），
 * 快照里只存那个引用 —— 那是另一件事，不是往槽位表里补一行。
 *
 * **为什么现在接受**：丢失窗口只有「粘贴完还没发送」这一小段，且用户当场看得见附件没了
 * （不是静默错值）；代价与上面那套暂存机制不相称。它不在门禁的枚举面里，理由是物理的 ——
 * 它不在 core 的任何一个 store 里。
 */
export const composerImageAttachmentAtom = atom<ComposerImageAttachmentState>({
  images: [],
  operation: 'idle',
  revision: 0,
})

function fileId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
}

function formatBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

function reject(
  set: (atom: typeof composerImageAttachmentAtom, state: ComposerImageAttachmentState) => void,
  current: ComposerImageAttachmentState,
  error: string,
) {
  set(composerImageAttachmentAtom, { ...current, operation: 'idle', error })
}

export const addComposerImageAttachmentsAtom = atom(null, async (
  get,
  set,
  input: { readonly files: readonly File[]; readonly capability: ImageInputCapability },
) => {
  const current = get(composerImageAttachmentAtom)
  if (current.operation !== 'idle' || input.files.length === 0) return
  if (input.capability.kind !== 'provider-upload') {
    reject(set, current, input.capability.reason)
    return
  }
  const { accept, limits } = input.capability
  const unsupported = input.files.find((file) => !accept.includes(file.type))
  if (unsupported) {
    reject(set, current, translateMessage(msg`“${unsupported.name}”不是当前模型支持的图片格式。`))
    return
  }
  const oversized = input.files.find((file) => file.size > limits.maxBytesPerImage)
  if (oversized) {
    reject(set, current, translateMessage(msg`“${oversized.name}”超过单张 ${formatBytes(limits.maxBytesPerImage)} 限制。`))
    return
  }
  if (current.images.length + input.files.length > limits.maxImages) {
    reject(set, current, translateMessage(msg`最多可附加 ${limits.maxImages} 张图片。`))
    return
  }
  const batchBytes = current.images.reduce((total, image) => total + image.byteSize, 0)
    + input.files.reduce((total, file) => total + file.size, 0)
  if (batchBytes > limits.maxBatchBytes) {
    reject(set, current, translateMessage(msg`图片总大小不能超过 ${formatBytes(limits.maxBatchBytes)}。`))
    return
  }
  const revision = current.revision
  set(composerImageAttachmentAtom, { ...current, operation: 'validating', error: undefined })
  try {
    const inspections = await Promise.all(input.files.map(async (file) => {
      try {
        return { dimensions: await inspectStaticImage(file, file.type, limits) }
      } catch (error) {
        return { error }
      }
    }))
    const rejectedIndex = inspections.findIndex((inspection) => inspection.error)
    if (rejectedIndex >= 0) {
      const latest = get(composerImageAttachmentAtom)
      if (latest.revision === revision) {
        const file = input.files[rejectedIndex]
        const error = inspections[rejectedIndex].error
        if (error instanceof StaticImagePolicyError && error.code === 'animated') {
          reject(set, latest, translateMessage(msg`“${file.name}”是动图，请选择静态图片。`))
        } else if (error instanceof StaticImagePolicyError && error.code === 'dimensions') {
          reject(set, latest, translateMessage(msg`图片尺寸不能超过 ${limits.maxWidth} × ${limits.maxHeight}。`))
        } else {
          reject(set, latest, translateMessage(msg`“${file.name}”不是有效的图片文件。`))
        }
      }
      return
    }
    const dimensions = inspections.map((inspection) => inspection.dimensions!)
    const latest = get(composerImageAttachmentAtom)
    if (latest.revision !== revision || latest.operation !== 'validating') return
    const images = input.files.map((file, index) => ({
      id: fileId(),
      file,
      name: file.name || translateMessage(msg`未命名图片`),
      mimeType: file.type,
      byteSize: file.size,
      ...dimensions[index],
    }))
    set(composerImageAttachmentAtom, {
      images: [...latest.images, ...images],
      operation: 'idle',
      revision: latest.revision + 1,
    })
  } catch (error) {
    const latest = get(composerImageAttachmentAtom)
    if (latest.revision === revision) {
      reject(set, latest, error instanceof Error ? error.message : translateMessage(msg`无法读取图片。`))
    }
  }
})

export const removeComposerImageAttachmentAtom = atom(null, (get, set, id: string) => {
  const current = get(composerImageAttachmentAtom)
  if (current.operation !== 'idle') return
  set(composerImageAttachmentAtom, {
    images: current.images.filter((image) => image.id !== id),
    operation: 'idle',
    revision: current.revision + 1,
  })
})

export const clearComposerImageAttachmentsAtom = atom(null, (get, set) => {
  const current = get(composerImageAttachmentAtom)
  if (current.operation !== 'idle') return
  set(composerImageAttachmentAtom, { images: [], operation: 'idle', revision: current.revision + 1 })
})

export const setComposerImageAttachmentErrorAtom = atom(null, (get, set, error: string) => {
  const current = get(composerImageAttachmentAtom)
  if (current.operation !== 'idle') return
  set(composerImageAttachmentAtom, { ...current, error })
})

export const beginComposerImageSubmissionAtom = atom(null, (get, set) => {
  const current = get(composerImageAttachmentAtom)
  if (current.operation !== 'idle') return false
  set(composerImageAttachmentAtom, { ...current, operation: 'submitting', error: undefined })
  return true
})

export const settleComposerImageSubmissionAtom = atom(null, (
  get,
  set,
  input: { readonly revision: number; readonly accepted: boolean; readonly error?: string },
) => {
  const current = get(composerImageAttachmentAtom)
  const images = input.accepted && current.revision === input.revision ? [] : current.images
  set(composerImageAttachmentAtom, {
    images,
    operation: 'idle',
    error: input.accepted ? undefined : input.error ?? translateMessage(msg`图片尚未发送，请重试。`),
    revision: current.revision + (images.length !== current.images.length ? 1 : 0),
  })
})
