// tools/save-file/save-file.ts —— 副作用工具「save_file」（TOOLS-SPEC §9/§10/§12）。
// 关键差异：不再直接 addPendingArtifact / 写 stale 守卫；暂存统一经 ctx.saveArtifact，
// harness 负责写 atom + 集中 stale/ghost 守卫，回 {artifactId} 或 {error}。
// 本文件零依赖：只 import 类型；绝不 import state/atom/store；副作用只经 ctx。
import type { Tool } from '@einfach-agent/core/tools'
import guide from './save-file.md?raw' // skill 正文（同目录 .md）

export const SAVE_FILE_MAX_BYTES = 5 * 1024 * 1024
export const SAVE_FILE_NAME_MAX_CHARS = 255
export const SAVE_FILE_MIME_MAX_CHARS = 255

// lazy schema（照旧 registry）：filename + content 必填，mimeType 可选。
const inputSchema = {
  type: 'object',
  properties: {
    filename: { type: 'string', minLength: 1, maxLength: SAVE_FILE_NAME_MAX_CHARS },
    content: { type: 'string', maxLength: SAVE_FILE_MAX_BYTES },
    mimeType: { type: 'string', maxLength: SAVE_FILE_MIME_MAX_CHARS },
  },
  required: ['filename', 'content'],
  additionalProperties: false,
}

// 把未知 args 安全视为普通对象，避免直接取字段崩。
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export const saveFileTool: Tool = {
  name: 'save_file',
  runtime: 'browser',
  replayUnsafe: true,
  skill: {
    description: '准备一份文件内容供用户在浏览器内手势保存到本地（File System Access）。',
    triggers: ['保存', '下载', 'save', 'file', '导出'],
    content: guide,
  },
  inputSchema,
  execute(args, ctx) {
    // 1) 防御式取参：filename 非空 string（trim 后判空）、content 必须是 string（空串合法）。
    const input = asRecord(args)
    const filename = typeof input.filename === 'string' ? input.filename.trim() : ''
    const hasStringContent = typeof input.content === 'string'
    const content = hasStringContent ? (input.content as string) : ''
    const mimeType =
      typeof input.mimeType === 'string' && input.mimeType.trim() ? input.mimeType.trim() : undefined

    if (!filename || !hasStringContent) {
      return {
        ok: false,
        error: 'invalid save_file: filename (non-empty) and string content are required',
        code: 'SAVE_FILE_INVALID_INPUT',
        retryable: false,
      }
    }
    if (
      filename.length > SAVE_FILE_NAME_MAX_CHARS
      || (mimeType?.length ?? 0) > SAVE_FILE_MIME_MAX_CHARS
    ) {
      return {
        ok: false,
        error: 'invalid save_file: filename or mimeType exceeds the supported length',
        code: 'SAVE_FILE_METADATA_TOO_LARGE',
        retryable: false,
      }
    }

    const bytes = new TextEncoder().encode(content).byteLength
    if (bytes > SAVE_FILE_MAX_BYTES) {
      return {
        ok: false,
        error: `invalid save_file: content is ${bytes} bytes; maximum is ${SAVE_FILE_MAX_BYTES}`,
        code: 'SAVE_FILE_TOO_LARGE',
        retryable: false,
        hint: 'Write large output to the workspace in chunks or reduce the exported content.',
      }
    }

    // 2) 副作用只经 ctx：harness 写 atom + 施 stale/ghost 守卫，回 {artifactId} 或 {error}。
    const file: { filename: string; content: string; mimeType?: string } = { filename, content }
    if (mimeType) file.mimeType = mimeType

    let r: ReturnType<typeof ctx.saveArtifact>
    try {
      r = ctx.saveArtifact(file)
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message || error.name : String(error),
        code: 'SAVE_ARTIFACT_FAILED',
        retryable: true,
      }
    }
    if ('error' in r) {
      return {
        ok: false,
        error: r.error,
        code: 'SAVE_ARTIFACT_FAILED',
        retryable: false,
      }
    }

    // 3) 成功：回 readiness（accepted / artifactId / bytes）给 model。
    return {
      ok: true,
      data: { accepted: true, artifactId: r.artifactId, bytes },
    }
  },
}
