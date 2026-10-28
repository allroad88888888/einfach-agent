import { useId, useRef, useState, type FormEvent } from 'react'
import type { BrowserAgentClient, ModelConnection } from '@einfach-agent/browser-agent'
import { EditorList, FormHeading } from './AgentEditor'
import { errorText } from './SettingsView'

interface ConnectionEditorProps {
  client: BrowserAgentClient
  connections: readonly ModelConnection[]
  report(text: string, error?: boolean): void
  onCreateAgent(connectionId: string): void
}

export function ConnectionEditor({ client, connections, report, onCreateAgent }: ConnectionEditorProps) {
  const [editing, setEditing] = useState<ModelConnection>()
  const [newDraft, setNewDraft] = useState(0)
  const [savedConnectionId, setSavedConnectionId] = useState('')
  const keyRef = useRef<HTMLInputElement>(null)
  const helpId = useId()
  const value = editing ?? { id: '', label: 'DeepSeek V4.1 Flash', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-flash'], credentialConfigured: false }
  function beginNew() { setEditing(undefined); setSavedConnectionId(''); setNewDraft((version) => version + 1) }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    try {
      const saved = await client.saveConnection({
        id: editing?.id,
        label: String(form.get('label')),
        baseUrl: String(form.get('baseUrl')),
        models: split(String(form.get('models'))),
        apiKey: String(form.get('apiKey')) || undefined,
      })
      if (keyRef.current) keyRef.current.value = ''
      setEditing(saved)
      setSavedConnectionId(saved.id)
      report('连接已保存；API Key 输入已清理且不会回显。')
    } catch (error) { report(errorText(error), true) }
  }
  async function remove() {
    if (!editing) return
    try { await client.deleteConnection(editing.id); beginNew(); report('连接已删除。') }
    catch (error) { report(errorText(error), true) }
  }
  return <div className="bav-editor-grid">
    <EditorList
      title="模型连接"
      selectedId={editing?.id}
      items={connections.map((item) => ({ id: item.id, label: item.label, meta: item.credentialConfigured ? 'API Key 已配置' : '未配置 API Key' }))}
      onSelect={(id) => { setSavedConnectionId(''); setEditing(connections.find((item) => item.id === id)) }}
      onNew={beginNew}
    />
    <form className="bav-form" onSubmit={save} key={editing?.id ?? `new-connection-${newDraft}`}>
      <FormHeading title={editing ? '编辑模型连接' : '配置模型与 API Key'} detail={editing ? '填写你实际使用的兼容接口；这里不会自动猜测或提供模型清单。' : '已预填 DeepSeek V4.1 Flash，填写 API Key 后保存即可；也可修改为其他兼容接口。'} />
      <label>连接名称<input name="label" defaultValue={value.label} placeholder="例如：团队模型服务" required /></label>
      <label>接口地址
        <input name="baseUrl" type="url" aria-label="接口地址" defaultValue={value.baseUrl} placeholder="例如：https://服务地址/v1" aria-describedby={`${helpId}-base-url`} required />
        <small id={`${helpId}-base-url`} className="bav-field-help">请求会发送到此地址下的 chat/completions。</small>
      </label>
      <label>模型 ID 列表
        <textarea name="models" aria-label="模型 ID 列表" defaultValue={value.models.join('\n')} placeholder={'填写服务实际提供的模型 ID\n每行一个，也可用逗号分隔'} aria-describedby={`${helpId}-models`} required />
        <small id={`${helpId}-models`} className="bav-field-help">保存后，创建 Agent 时可从这些模型中选择。</small>
      </label>
      <label>API Key<input ref={keyRef} name="apiKey" type="password" autoComplete="new-password" placeholder={value.credentialConfigured ? '已配置；留空保持不变' : '输入此服务的 API Key'} /></label>
      <p className={`bav-credential ${value.credentialConfigured ? 'configured' : ''}`}>{value.credentialConfigured ? 'API Key 已配置；为安全起见不会回显。' : '尚未配置 API Key'}</p>
      {savedConnectionId && <div className="bav-next-step"><strong>模型连接准备好了</strong><span>下一步创建 Agent，并选择刚保存的连接与模型。</span><button type="button" onClick={() => onCreateAgent(savedConnectionId)}>下一步：创建 Agent</button></div>}
      <div className="bav-form-actions"><button>保存模型连接</button>{editing && <button type="button" className="bav-danger" onClick={remove}>删除</button>}</div>
    </form>
  </div>
}

function split(value: string): string[] { return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean) }
