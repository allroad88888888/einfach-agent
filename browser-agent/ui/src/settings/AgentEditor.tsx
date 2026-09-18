import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { AgentProfile, BrowserAgentClient, BrowserAgentSnapshot } from '@einfach-agent/browser-agent'
import { errorText } from './SettingsView'

export function AgentEditor({ client, snapshot, report }: { client: BrowserAgentClient; snapshot: BrowserAgentSnapshot; report(text: string, error?: boolean): void }) {
  const [editing, setEditing] = useState<AgentProfile>()
  const [newDraft, setNewDraft] = useState(0)
  const empty = useMemo(() => ({ name: '', instructions: '', connectionId: snapshot.connections[0]?.id ?? '', model: snapshot.connections[0]?.models[0] ?? '', toolNames: [] as string[], skillNames: [] as string[] }), [snapshot.connections])
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

  function beginNew() { setEditing(undefined); setNewDraft((version) => version + 1) }
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
      beginNew(); report('Agent 已保存；新会话将使用这个版本。')
    } catch (error) { report(errorText(error), true) }
  }
  async function remove() {
    if (!editing) return
    try { await client.deleteAgent(editing.id); beginNew(); report('Agent 已删除。') }
    catch (error) { report(errorText(error), true) }
  }
  return <div className="bav-editor-grid">
    <EditorList title="Agent" items={snapshot.agents.map((item) => ({ id: item.id, label: item.name, meta: `r${item.revision}` }))} onSelect={(id) => setEditing(snapshot.agents.find((item) => item.id === id))} onNew={beginNew} />
    <form className="bav-form" onSubmit={save} key={editing?.id ?? `new-agent-${newDraft}`}>
      <FormHeading title={editing ? '编辑 Agent' : '新建 Agent'} detail={editing ? `当前版本 r${editing.revision}；已有会话继续使用创建时的快照。` : '定义模型、能力和工作说明。'} />
      {!snapshot.connections.length && <p className="bav-error">没有可用连接。请先创建至少一个模型连接。</p>}
      {(missingConnection || missingModel) && <p className="bav-error">当前配置引用了已不可用的{missingConnection ? '连接' : '模型'}。请选择可用项后再保存。</p>}
      <label>名称<input name="name" defaultValue={value.name} required /></label>
      <label>工作说明<textarea name="instructions" defaultValue={value.instructions} required /></label>
      <label>连接<select value={connectionId} onChange={(event) => chooseConnection(event.target.value)} required><option value="">选择连接</option>{missingConnection && <option value={connectionId}>{connectionId}（已缺失）</option>}{snapshot.connections.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label>模型<select value={model} onChange={(event) => setModel(event.target.value)} required><option value="">选择模型</option>{missingModel && <option value={model}>{model}（已缺失）</option>}{(connection?.models ?? []).map((item) => <option key={item}>{item}</option>)}</select></label>
      <fieldset><legend>工具</legend>{registeredTools.map((tool) => <ReferenceOption key={tool.name} name="tool" value={tool.name} checked={value.toolNames.includes(tool.name)} detail={tool.description} />)}{missingTools.map((name) => <ReferenceOption key={name} name="tool" value={name} checked missing />)}{!registeredTools.length && !missingTools.length && <p className="bav-empty">宿主没有注册可选工具。</p>}</fieldset>
      <fieldset><legend>技能</legend>{snapshot.skills.map((skill) => <ReferenceOption key={skill.name} name="skill" value={skill.name} checked={value.skillNames.includes(skill.name)} detail={`r${skill.revision}`} />)}{missingSkills.map((name) => <ReferenceOption key={name} name="skill" value={name} checked missing />)}{!snapshot.skills.length && !missingSkills.length && <p className="bav-empty">还没有技能。</p>}</fieldset>
      {(missingTools.length > 0 || missingSkills.length > 0) && <p className="bav-error">标为“已缺失”的引用会保留在草稿中。请明确取消选择后再保存。</p>}
      <div className="bav-form-actions"><button disabled={!connection || !connection.models.includes(model)}>保存 Agent</button>{editing && <button type="button" className="bav-danger" onClick={remove}>删除</button>}</div>
    </form>
  </div>
}

function ReferenceOption({ name, value, checked, detail, missing = false }: { name: 'tool' | 'skill'; value: string; checked: boolean; detail?: string; missing?: boolean }) {
  return <label className={missing ? 'bav-missing-reference' : ''}><input type="checkbox" name={name} value={value} defaultChecked={checked} /><span>{value}{missing ? <small>已缺失 · 取消选择后可保存</small> : detail && <small>{detail}</small>}</span></label>
}

export function EditorList({ title, items, onSelect, onNew }: { title: string; items: Array<{ id: string; label: string; meta: string }>; onSelect(id: string): void; onNew(): void }) {
  return <aside className="bav-editor-list"><div className="bav-editor-list-title"><h2>{title}</h2><button type="button" onClick={onNew}>新建</button></div>{items.length ? items.map((item) => <button type="button" key={item.id} onClick={() => onSelect(item.id)}><span>{item.label}</span><small>{item.meta}</small></button>) : <p className="bav-empty">暂无内容</p>}</aside>
}

export function FormHeading({ title, detail }: { title: string; detail: string }) { return <header className="bav-form-heading"><h2>{title}</h2><p>{detail}</p></header> }
