import type { ViewImageCapability, WorkspaceImageReadResult } from '@einfach-agent/core'
import { DEEPSEEK_FLASH_TOOL_IMAGE_INPUT, isAbortError } from '@einfach-agent/ai'
import { prepareInlineBase64ImageBatch } from '../modelInput/inlineBase64ImageBatch'
import { resizeVisionImage } from './resizeVisionImage'

export interface InlineImageViewerOptions {
  resizeImage?: typeof resizeVisionImage
}

function safeFailure(message: string, error: unknown): Error {
  if (isAbortError(error)) return error as Error
  if (error instanceof Error && error.message === 'stale') return error
  return new Error(message)
}

/** Reads one workspace image into provider-neutral inline content without invoking a model. */
export function createInlineImageViewer(
  options: InlineImageViewerOptions = {},
): ViewImageCapability {
  const resizeImage = options.resizeImage ?? resizeVisionImage

  return async (input, context) => {
    let source: WorkspaceImageReadResult
    try {
      source = await context.readWorkspaceImage({
        path: input.path,
        maxBytes: DEEPSEEK_FLASH_TOOL_IMAGE_INPUT.limits.maxBytesPerImage,
      })
      context.assertFresh()
      context.signal.throwIfAborted()
    } catch (error) {
      throw safeFailure('当前宿主不支持读取图片', error)
    }

    try {
      const image = await resizeImage(source, input.detail, context.signal)
      context.assertFresh()
      const [block] = await prepareInlineBase64ImageBatch([image], {
        capability: DEEPSEEK_FLASH_TOOL_IMAGE_INPUT,
        signal: context.signal,
      })
      context.assertFresh()
      if (!block) throw new Error('image conversion returned no content')
      return { image: { ...block, detail: 'original' } }
    } catch (error) {
      throw safeFailure('图片预处理失败，无法读取', error)
    }
  }
}
