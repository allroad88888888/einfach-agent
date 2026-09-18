import { useRef, useState, type FormEvent } from 'react'
import type { BrowserAgentClient, ModelConnection } from '@einfach-agent/browser-agent'
import { EditorList, FormHeading } from './AgentEditor'
import { errorText } from './SettingsView'

export function ConnectionEditor({ client, connections, report }: { client: BrowserAgentClient; connections: readonly ModelConnection[]; report(text: string, error?: boolean): void }) {
  const [editing, setEditing] = useState<ModelConnection>()
  const [newDraft, setNewDraft] = useState(0)
  const keyRef = useRef<HTMLInputElement>(null)
  const value = editing ?? { id: '', label: '', baseUrl: '', models: [], credentialConfigured: false }
  function beginNew() { setEditing(undefined); setNewDraft((version) => version + 1) }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget)
    try {
      await client.saveConnection({ id: editing?.id, label: String(form.get('label')), baseUrl: String(form.get('baseUrl')), models: split(String(form.get('models'))), apiKey: String(form.get('apiKey')) || undefined })
      if (keyRef.current) keyRef.current.value = ''
      beginNew(); report('连接已保存；密钥输入已清理。')
    } catch (error) { report(errorText(error), true) }
  }
  async function remove() { if (!editing) return; try { await client.deleteConnection(editing.id); beginNew(); report('连接已删除。') } catch (error) { report(errorText(error), true) } }
  return <div className="bav-editor-grid"><EditorList title="模型连接" items={connections.map((item) => ({ id: item.id, label: item.label, meta: item.credentialConfigured ? '密钥已配置' : '未配置密钥' }))} onSelect={(id) => setEditing(connections.find((item) => item.id === id))} onNew={beginNew} /><form className="bav-form" onSubmit={save} key={editing?.id ?? `new-connection-${newDraft}`}><FormHeading title={editing ? '编辑连接' : '新建连接'} detail="Endpoint 与模型用于新会话；密钥只会提交，不会回填明文。" /><label>标签<input name="label" defaultValue={value.label} required /></label><label>Endpoint<input name="baseUrl" type="url" defaultValue={value.baseUrl} required /></label><label>模型（每行或逗号分隔）<textarea name="models" defaultValue={value.models.join('\n')} required /></label><label>API key<input ref={keyRef} name="apiKey" type="password" autoComplete="new-password" placeholder={value.credentialConfigured ? '已配置；留空保持不变' : '输入 API key'} /></label><p className={`bav-credential ${value.credentialConfigured ? 'configured' : ''}`}>{value.credentialConfigured ? '密钥已配置' : '尚未配置密钥'}</p><div className="bav-form-actions"><button>保存连接</button>{editing && <button type="button" className="bav-danger" onClick={remove}>删除</button>}</div></form></div>
}
function split(value: string): string[] { return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean) }
