import { useEffect, useState, type FormEvent } from 'react'
import type { BrowserAgentClient, ConfiguredSkill } from '@einfach-agent/browser-agent'
import { EditorList, FormHeading } from './AgentEditor'
import { errorText } from './SettingsView'

interface ResourceDraft { id: string; name: string; content: string }
const drafts = (resources: Readonly<Record<string, string>>): ResourceDraft[] => Object.entries(resources).map(([name, content], index) => ({ id: `${index}:${name}`, name, content }))

export function SkillEditor({ client, skills, report }: { client: BrowserAgentClient; skills: readonly ConfiguredSkill[]; report(text: string, error?: boolean): void }) {
  const [editing, setEditing] = useState<ConfiguredSkill>()
  const [newDraft, setNewDraft] = useState(0)
  const [resources, setResources] = useState<ResourceDraft[]>([])
  const value = editing ?? { name: '', description: '', triggers: [], content: '', resources: {}, revision: 0 }
  useEffect(() => setResources(drafts(value.resources)), [editing])
  function beginNew() { setEditing(undefined); setResources([]); setNewDraft((version) => version + 1) }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const named = resources.filter((item) => item.name.trim())
    if (new Set(named.map((item) => item.name.trim())).size !== named.length) { report('文本资源名称不能重复。', true); return }
    try {
      await client.saveSkill({ name: String(form.get('name')), description: String(form.get('description')), triggers: String(form.get('triggers')).split(',').map((item) => item.trim()).filter(Boolean), content: String(form.get('content')), resources: Object.fromEntries(named.map((item) => [item.name.trim(), item.content])) })
      beginNew(); report('技能已保存；已有会话仍使用创建时的版本。')
    } catch (error) { report(errorText(error), true) }
  }
  async function remove() { if (!editing) return; try { await client.deleteSkill(editing.name); beginNew(); report('技能已删除。') } catch (error) { report(errorText(error), true) } }
  const update = (id: string, patch: Partial<ResourceDraft>) => setResources((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item))
  return <div className="bav-editor-grid">
    <EditorList title="技能" selectedId={editing?.name} items={skills.map((item) => ({ id: item.name, label: item.name, meta: `r${item.revision}` }))} onSelect={(id) => setEditing(skills.find((item) => item.name === id))} onNew={beginNew} />
    <form className="bav-form" onSubmit={save} key={editing?.name ?? `new-skill-${newDraft}`}>
      <FormHeading title={editing ? '编辑技能' : '新建技能'} detail="技能由说明和文本资源组成，不会作为脚本执行。" />
      <label>名称<input name="name" defaultValue={value.name} readOnly={Boolean(editing)} required /></label>
      <label>描述<input name="description" defaultValue={value.description} required /></label>
      <label>触发词（逗号分隔）<input name="triggers" defaultValue={value.triggers.join(', ')} /></label>
      <label>正文<textarea name="content" className="bav-long-text" defaultValue={value.content} required /></label>
      <fieldset className="bav-resources"><legend>文本资源</legend>
        {resources.map((resource) => <div className="bav-resource" key={resource.id}>
          <label>资源名称<input aria-label="资源名称" value={resource.name} onChange={(event) => update(resource.id, { name: event.target.value })} placeholder="reference.md" /></label>
          <label>内容<textarea aria-label={`${resource.name || '未命名资源'}内容`} value={resource.content} onChange={(event) => update(resource.id, { content: event.target.value })} /></label>
          <button type="button" className="bav-text-button" onClick={() => setResources((items) => items.filter((item) => item.id !== resource.id))}>移除资源</button>
        </div>)}
        <button type="button" className="bav-secondary" onClick={() => setResources((items) => [...items, { id: crypto.randomUUID(), name: '', content: '' }])}>添加文本资源</button>
      </fieldset>
      <div className="bav-form-actions"><button>保存技能</button>{editing && <button type="button" className="bav-danger" onClick={remove}>删除</button>}</div>
    </form>
  </div>
}
