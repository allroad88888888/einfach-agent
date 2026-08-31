import type { ViewImageCapability, WorkspaceImageReadResult } from '@einfach-agent/core'
import {
  callDeepSeek,
  DEEPSEEK_VISION_MODEL,
  isAbortError,
  prepareDeepSeekImageBatch,
  type DeepSeekLocalImage,
} from '@einfach-agent/ai'
import { resizeVisionImage } from './resizeVisionImage'

const IMAGE_OBSERVATION_PROMPT =
  '请观察这张工作区图片并准确描述与当前任务相关的可见内容。不要猜测图片中不存在的信息。'

export interface DeepSeekImageViewerOptions {
  apiKey: string
  fetchImpl?: typeof fetch
  resizeImage?: typeof resizeVisionImage
}

function safeFailure(message: string, error: unknown): Error {
  if (isAbortError(error)) return error as Error
  if (error instanceof Error && error.message === 'stale') return error
  return new Error(message)
}

/** Runs one isolated DeepSeek vision observation and always disposes its uploaded file. */
export function createDeepSeekImageViewer(
  options: DeepSeekImageViewerOptions,
): ViewImageCapability {
  const resizeImage = options.resizeImage ?? resizeVisionImage

  return async (input, context) => {
    let source: WorkspaceImageReadResult
    try {
      source = await context.readWorkspaceImage({ path: input.path })
      context.assertFresh()
      context.signal.throwIfAborted()
    } catch (error) {
      throw safeFailure('当前宿主不支持读取图片', error)
    }

    let image: DeepSeekLocalImage
    try {
      image = await resizeImage(source, input.detail, context.signal)
      context.assertFresh()
    } catch (error) {
      throw safeFailure('图片预处理失败，无法进行视觉读取', error)
    }

    let batch: Awaited<ReturnType<typeof prepareDeepSeekImageBatch>>
    try {
      batch = await prepareDeepSeekImageBatch([image], {
        apiKey: options.apiKey,
        fetchImpl: options.fetchImpl,
        signal: context.signal,
      })
    } catch (error) {
      throw safeFailure('图片上传失败，无法进行视觉读取', error)
    }

    try {
      context.assertFresh()
      context.signal.throwIfAborted()
      const response = await callDeepSeek({
        model: DEEPSEEK_VISION_MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: IMAGE_OBSERVATION_PROMPT },
            ...batch.blocks,
          ],
        }],
        stream: false,
      }, {
        apiKey: options.apiKey,
        fetchImpl: options.fetchImpl,
        signal: context.signal,
      })
      context.assertFresh()
      context.signal.throwIfAborted()
      const content = response.choices?.[0]?.message?.content
      const model = response.model
      if (typeof content !== 'string' || content.trim().length === 0
        || typeof model !== 'string' || model.trim().length === 0) {
        throw new Error('invalid vision response')
      }
      return { content, model }
    } catch (error) {
      throw safeFailure('视觉模型调用失败，请稍后重试', error)
    } finally {
      await batch.rollback().catch(() => undefined)
    }
  }
}
