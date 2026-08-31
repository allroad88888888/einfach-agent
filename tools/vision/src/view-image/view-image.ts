import type { Tool, ToolContext } from '@einfach-agent/core/tools'
import guide from './view-image.md?raw'

const inputSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1 },
    detail: { type: 'string', enum: ['low', 'high'], default: 'low' },
  },
  required: ['path'],
  additionalProperties: false,
}

type ViewImage = NonNullable<ToolContext['viewImage']>

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function normalizeDetail(value: unknown): 'low' | 'high' | undefined {
  if (value === undefined) return 'low'
  return value === 'low' || value === 'high' ? value : undefined
}

function getViewImage(ctx: ToolContext): ViewImage | undefined {
  const candidate = (ctx as Partial<ToolContext>).viewImage
  return typeof candidate === 'function' ? candidate.bind(ctx) : undefined
}

function textObservation(value: unknown): { content: string; model: string } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const result = value as { content?: unknown; model?: unknown }
  return typeof result.content === 'string' && typeof result.model === 'string'
    ? { content: result.content, model: result.model }
    : undefined
}

export const viewImageTool: Tool = {
  name: 'view_image',
  runtime: 'server',
  replayUnsafe: true,
  skill: {
    description: '查看图片并返回文字观察；普通图片优先 low，OCR、小字截图、密集图表或精细比较使用 high。',
    triggers: ['view image', 'inspect image', '查看图片', '识别图片', 'OCR', '截图小字', '图表'],
    content: guide,
  },
  inputSchema,
  async execute(args, ctx) {
    const input = asRecord(args)
    const path = typeof input.path === 'string' ? input.path.trim() : ''
    if (!path) {
      return {
        ok: false,
        error: 'invalid view_image: path (non-empty string) is required',
        code: 'VIEW_IMAGE_INVALID_INPUT',
        retryable: false,
      }
    }

    const detail = normalizeDetail(input.detail)
    if (!detail) {
      return {
        ok: false,
        error: 'invalid view_image: detail must be "low" or "high"',
        code: 'VIEW_IMAGE_INVALID_INPUT',
        retryable: false,
      }
    }

    const viewImage = getViewImage(ctx)
    if (!viewImage) {
      return {
        ok: false,
        error: 'view_image unavailable: ctx.viewImage is not configured',
        code: 'VIEW_IMAGE_UNAVAILABLE',
        retryable: false,
      }
    }

    try {
      const result = textObservation(await viewImage({ path, detail }))
      if (!result) {
        return {
          ok: false,
          error: 'view_image failed: vision runtime returned an invalid response',
          code: 'VIEW_IMAGE_INVALID_RESPONSE',
          retryable: false,
        }
      }
      return { ok: true, data: result }
    } catch {
      return {
        ok: false,
        error: 'view_image failed: vision runtime could not inspect the image',
        code: 'VIEW_IMAGE_FAILED',
        retryable: true,
      }
    }
  },
}
