import type { Tool, ToolRegistry } from '@einfach-agent/core/tools'
import { OcrError, runPaddleOcr, type OcrHost, type OcrInput } from './client'
import { record } from './result'

export function createPaddleOcrTool(host: OcrHost): Tool {
  return {
    name: 'paddle_ocr', runtime: 'browser', replayUnsafe: true,
    execution: { mode: 'serial', effectKeys: ['paddle-ocr:submit'] },
    skill: { description: '识别 PDF 或图片中的文字，返回分页面文本、置信度和标注图片链接。', triggers: ['OCR', 'PDF', '扫描件', '图片文字', '合同识别'], content: '使用 PP-OCRv6。来源三选一：当前会话附件 attachmentId、可公开访问的 fileUrl、已提交任务 jobId。附件 ID 从用户消息获取，不接受本地路径。仅支持 PDF/图片，不支持 Word。服务需要宿主配置 Token，禁止向用户索取 Token 放入工具参数。上传会将文件交给 PaddleOCR。超时或查询失败如返回 jobId，必须使用该 jobId 继续查询，不能重复提交。取消只停止客户端等待。OCR 不保证准确，关键业务字段应核对。truncated=true 表示结果不完整，可用 jobId 增大 maxChars，或另行限定 pageRanges。' },
    inputSchema: { type: 'object', properties: {
      attachmentId: { type: 'string', description: '用户消息中的会话附件 ID' }, fileUrl: { type: 'string', description: 'PDF/图片的公开 HTTP(S) 地址' }, jobId: { type: 'string', description: '继续查询已有任务，避免重复创建' },
      pageRanges: { type: 'string', description: '可选页码范围，例如 1-3,5；只在提交时生效' },
      timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 }, maxChars: { type: 'integer', minimum: 1, maximum: 50000 },
      useDocOrientationClassify: { type: 'boolean' }, useDocUnwarping: { type: 'boolean' }, useTextlineOrientation: { type: 'boolean' },
    }, additionalProperties: false },
    async execute(args, ctx) {
      try { return { ok: true, data: await runPaddleOcr(record(args) as OcrInput, ctx, host) } }
      catch (error) {
        const failure = error instanceof OcrError ? error : new OcrError('OCR 执行失败。', 'OCR_FAILED')
        return { ok: false, error: failure.message, code: failure.code, retryable: false, ...(failure.jobId ? { details: { jobId: failure.jobId }, hint: failure.code === 'OCR_JOB_FAILED' ? '任务已失败；先检查输入和服务状态，停止重复查询。' : '使用此 jobId 查询已有任务，不要重复提交文件。' } : {}) }
      }
    },
  }
}
export function registerOcrTools(registry: ToolRegistry, host: OcrHost): void { registry.register(createPaddleOcrTool(host)) }
