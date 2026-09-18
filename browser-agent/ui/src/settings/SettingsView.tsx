import { useState } from 'react'
import type { BrowserAgentClient, BrowserAgentSnapshot } from '@einfach-agent/browser-agent'
import { AgentEditor } from './AgentEditor'
import { ConnectionEditor } from './ConnectionEditor'
import { SkillEditor } from './SkillEditor'

type Section = 'agents' | 'skills' | 'connections'

export function SettingsView({ client, snapshot }: { client: BrowserAgentClient; snapshot: BrowserAgentSnapshot }) {
  const [section, setSection] = useState<Section>('agents')
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string }>()
  const report = (text: string, error = false) => setNotice({ kind: error ? 'error' : 'success', text })
  return <section className="bav-panel bav-settings">
    <nav className="bav-subtabs" aria-label="配置类型">
      <button type="button" className={section === 'agents' ? 'is-active' : ''} onClick={() => setSection('agents')}>Agent</button>
      <button type="button" className={section === 'skills' ? 'is-active' : ''} onClick={() => setSection('skills')}>技能</button>
      <button type="button" className={section === 'connections' ? 'is-active' : ''} onClick={() => setSection('connections')}>连接</button>
    </nav>
    {notice && <p role="status" className={`bav-notice ${notice.kind}`}>{notice.text}</p>}
    {section === 'agents' && <AgentEditor client={client} snapshot={snapshot} report={report} />}
    {section === 'skills' && <SkillEditor client={client} skills={snapshot.skills} report={report} />}
    {section === 'connections' && <ConnectionEditor client={client} connections={snapshot.connections} report={report} />}
  </section>
}

export function errorText(value: unknown): string { return value instanceof Error ? value.message : '操作失败，请重试' }
