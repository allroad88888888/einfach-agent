import { useRef, useState, type FormEvent } from 'react'
import type { BrowserAgentClient } from '@einfach-agent/browser-agent'
import { FormHeading } from './AgentEditor'
import { errorText } from './SettingsView'

export function OcrSettings({ client, configured, report }: { client: BrowserAgentClient; configured: boolean; report(text: string, error?: boolean): void }) {
  const token = useRef<HTMLInputElement>(null)
  const [saving, setSaving] = useState(false)
  async function save(event: FormEvent) {
    event.preventDefault()
    const value = token.current?.value.trim()
    if (!value || saving) return
    setSaving(true)
    try { await client.saveOcrToken(value); if (token.current) token.current.value = ''; report('PaddleOCR Token 已保存，输入框已清空。') }
    catch (error) { report(errorText(error), true) }
    finally { setSaving(false) }
  }
  async function remove() {
    setSaving(true)
    try { await client.saveOcrToken(''); if (token.current) token.current.value = ''; report('PaddleOCR Token 已移除。') }
    catch (error) { report(errorText(error), true) }
    finally { setSaving(false) }
  }
  return <form className="bav-form" onSubmit={save}>
    <FormHeading title="PaddleOCR" detail="识别 PDF、扫描件和图片中的文字，供 Agent 分析或填写表单。" />
    <p className="bav-field-help">使用 PP-OCRv6。调用工具时，文件会发送到 PaddleOCR 官方服务。</p>
    <label>OCR Token<input ref={token} name="ocr-token" aria-label="OCR Token" type="password" autoComplete="new-password" placeholder={configured ? '已配置；输入新 Token 可替换' : '输入 AI Studio Token'} disabled={saving} /></label>
    <p className={`bav-credential${configured ? ' configured' : ''}`}>{configured ? 'Token 已配置，不回显。' : '尚未配置 Token'}</p>
    <p className="bav-field-help">保存后，在 Agent 的工具能力里选择 paddle_ocr，再用该 Agent 新建会话。旧会话保持原有工具配置。Word 文件请先导出为 PDF。</p>
    <div className="bav-form-actions"><button disabled={saving}>保存 OCR 配置</button>{configured && <button type="button" className="bav-secondary" disabled={saving} onClick={remove}>移除 Token</button>}</div>
  </form>
}
