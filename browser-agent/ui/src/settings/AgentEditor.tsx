import { Children, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import type { AgentProfile, BrowserAgentClient, BrowserAgentSnapshot } from '@einfach-agent/browser-agent'
import { errorText } from './SettingsView'

export function AgentEditor({ client, snapshot, report, preferredConnectionId, onManageConnection, onOpenChat }: { client: BrowserAgentClient; snapshot: BrowserAgentSnapshot; report(text: string, error?: boolean): void; preferredConnectionId: string; onManageConnection(): void; onOpenChat(): void }) {
  const [editing, setEditing] = useState<AgentProfile>()
  const [newDraft, setNewDraft] = useState(0)
  const [saved, setSaved] = useState(false)
  const empty = useMemo(() => { const connection = snapshot.connections.find((item) => item.id === preferredConnectionId) ?? snapshot.connections[0]; return ({ name: '', instructions: '', connectionId: connection?.id ?? '', model: connection?.models[0] ?? '', toolNames: [] as string[], skillNames: [] as string[] }) }, [preferredConnectionId, snapshot.connections])
  const value = editing ?? empty
  const [connectionId, setConnectionId] = useState(value.connectionId)
  const [model, setModel] = useState(value.model)
  const connection = snapshot.connections.find((item) => item.id === connectionId)
  const registeredTools = client.core.tools.list()
  const missingTools = value.toolNames.filter((name) => !registeredTools.some((tool) => tool.name === name))
  const missingSkills = value.skillNames.filter((name) => !snapshot.skills.some((skill) => skill.name === name))
  const missingConnection = Boolean(connectionId && !connection)
  const missingModel = Boolean(connection && model && !connection.models.includes(model))
  useEffect(() => { setConnectionId(value.connectionId); setModel(value.model) }, [value.connectionId, value.model, newDraft])

  function beginNew() { setSaved(false); setEditing(undefined); setNewDraft((version) => version + 1) }
  function chooseConnection(nextId: string) {
    setConnectionId(nextId)
    setModel(snapshot.connections.find((item) => item.id === nextId)?.models[0] ?? '')
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const toolNames = form.getAll('tool').map(String)
    const skillNames = form.getAll('skill').map(String)
    const unresolved = [...missingTools.filter((name) => toolNames.includes(name)), ...missingSkills.filter((name) => skillNames.includes(name))]
    if (unresolved.length) { report(`请先移除缺失引用：${unresolved.join('、')}`, true); return }
    if (!connection || !connection.models.includes(model)) { report('请选择当前可用的连接和模型。', true); return }
    try {
      await client.saveAgent({ id: editing?.id, name: String(form.get('name')), instructions: String(form.get('instructions')), connectionId, model, toolNames, skillNames })
      setEditing(undefined); setNewDraft((version) => version + 1); setSaved(true); report('Agent 已保存；现在可以回到对话创建会话。')
    } catch (error) { report(errorText(error), true) }
  }
  async function remove() {
    if (!editing) return
    try { await client.deleteAgent(editing.id); beginNew(); report('Agent 已删除。') }
    catch (error) { report(errorText(error), true) }
  }
  return <div className="bav-editor-grid">
    <EditorList title="Agent" selectedId={editing?.id} items={snapshot.agents.map((item) => ({ id: item.id, label: item.name, meta: `r${item.revision}` }))} onSelect={(id) => { setSaved(false); setEditing(snapshot.agents.find((item) => item.id === id)) }} onNew={beginNew} />
    <form className="bav-form" onSubmit={save} key={editing?.id ?? `new-agent-${newDraft}`}>
      <FormHeading title={editing ? '编辑 Agent' : '新建 Agent'} detail={editing ? `当前版本 r${editing.revision}；已有会话继续使用创建时的快照。` : '定义模型、能力和工作说明。'} />
      {!snapshot.connections.length && <div className="bav-next-step is-error"><strong>还没有模型连接</strong><span>先填写接口地址、模型 ID 与 API Key，再回来创建 Agent。</span><button type="button" onClick={onManageConnection}>配置模型与 API Key</button></div>}
      {snapshot.connections.length > 0 && <div className="bav-inline-action"><span>需要修改模型列表、接口地址或 API Key？</span><button type="button" className="bav-secondary" onClick={onManageConnection}>管理模型与 API Key</button></div>}
      {(missingConnection || missingModel) && <p className="bav-error">当前配置引用了已不可用的{missingConnection ? '连接' : '模型'}。请选择可用项后再保存。</p>}
      <label>名称<input name="name" defaultValue={value.name} required /></label>
      <label>工作说明<textarea name="instructions" defaultValue={value.instructions} required /></label>
      <label>连接<select value={connectionId} onChange={(event) => chooseConnection(event.target.value)} required><option value="">选择连接</option>{missingConnection && <option value={connectionId}>{connectionId}（已缺失）</option>}{snapshot.connections.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label>模型<select value={model} onChange={(event) => setModel(event.target.value)} required><option value="">选择模型</option>{missingModel && <option value={model}>{model}（已缺失）</option>}{(connection?.models ?? []).map((item) => <option key={item}>{item}</option>)}</select></label>
      <CapabilityGroup key={`tools-${editing?.id ?? newDraft}`} label="工具能力" name="tool" selected={value.toolNames} missing={missingTools}>{registeredTools.map((tool) => <ReferenceOption key={tool.name} name="tool" value={tool.name} checked={value.toolNames.includes(tool.name)} detail={tool.description} />)}</CapabilityGroup>
      <CapabilityGroup key={`skills-${editing?.id ?? newDraft}`} label="技能能力" name="skill" selected={value.skillNames} missing={missingSkills}>{snapshot.skills.map((skill) => <ReferenceOption key={skill.name} name="skill" value={skill.name} checked={value.skillNames.includes(skill.name)} detail={`r${skill.revision}`} />)}</CapabilityGroup>
      {(missingTools.length > 0 || missingSkills.length > 0) && <p className="bav-error">标为“已缺失”的引用会保留在草稿中。请明确取消选择后再保存。</p>}
      {saved && <div className="bav-next-step"><strong>Agent 已准备好</strong><span>回到对话，选择这个 Agent 并创建会话。</span><button type="button" onClick={onOpenChat}>回到对话并创建会话</button></div>}
      <div className="bav-form-actions"><button disabled={!connection || !connection.models.includes(model)}>保存 Agent</button>{editing && <button type="button" className="bav-danger" onClick={remove}>删除</button>}</div>
    </form>
  </div>
}

function CapabilityGroup({ label, name, selected, missing, children }: { label: string; name: 'tool' | 'skill'; selected: readonly string[]; missing: readonly string[]; children: ReactNode }) {
  const [count, setCount] = useState(selected.length)
  return <details className="bav-capabilities" open={missing.length > 0} onChange={(event) => { if (!event.currentTarget.open) setCount(event.currentTarget.querySelectorAll('input:checked').length) }}>
    <summary><span>{label}</span><small>{count} 项已选{missing.length ? ` · ${missing.length} 项缺失` : ''}</small></summary>
    <fieldset aria-label={label} onChange={(event) => setCount(event.currentTarget.querySelectorAll('input:checked').length)}>
      {children}{missing.map((value) => <ReferenceOption key={value} name={name} value={value} checked missing />)}
      {!selected.length && !missing.length && Children.count(children) === 0 && <p className="bav-empty">暂无可选项。</p>}
    </fieldset>
  </details>
}

function ReferenceOption({ name, value, checked, detail, missing = false }: { name: 'tool' | 'skill'; value: string; checked: boolean; detail?: string; missing?: boolean }) {
  return <label className={missing ? 'bav-missing-reference' : ''}><input type="checkbox" name={name} value={value} defaultChecked={checked} /><span>{value}{missing ? <small>已缺失 · 取消选择后可保存</small> : detail && <small>{detail}</small>}</span></label>
}

export function EditorList({ title, items, selectedId, onSelect, onNew }: { title: string; items: Array<{ id: string; label: string; meta: string }>; selectedId?: string; onSelect(id: string): void; onNew(): void }) {
  return <aside className="bav-editor-list"><div className="bav-editor-list-title"><h2>{title}</h2><button type="button" onClick={onNew}>新建</button></div>{items.length ? items.map((item) => <button type="button" aria-pressed={item.id === selectedId} key={item.id} onClick={() => onSelect(item.id)}><span>{item.label}</span><small>{item.meta}</small></button>) : <p className="bav-empty">暂无内容</p>}</aside>
}

export function FormHeading({ title, detail }: { title: string; detail: string }) { return <header className="bav-form-heading"><h2>{title}</h2><p>{detail}</p></header> }
