import { useEffect, useState, type KeyboardEvent, type RefObject } from 'react'
import type { BrowserAgentClient, BrowserAgentSnapshot } from '@einfach-agent/browser-agent'
import { AgentEditor } from './AgentEditor'
import { ConnectionEditor } from './ConnectionEditor'
import { SkillEditor } from './SkillEditor'
import { OcrSettings } from './OcrSettings'

export type SettingsSection = 'agents' | 'skills' | 'connections' | 'services'

export function SettingsView({ client, snapshot, section, onSectionChange, onOpenChat, headingRef }: { client: BrowserAgentClient; snapshot: BrowserAgentSnapshot; section: SettingsSection; onSectionChange(section: SettingsSection): void; onOpenChat(): void; headingRef: RefObject<HTMLHeadingElement> }) {
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string }>()
  const [preferredConnectionId, setPreferredConnectionId] = useState('')
  useEffect(() => setNotice(undefined), [section])
  const report = (text: string, error = false) => setNotice({ kind: error ? 'error' : 'success', text })
  function useConnection(connectionId: string) { setPreferredConnectionId(connectionId); onSectionChange('agents') }
  function keyDown(event: KeyboardEvent<HTMLElement>) { if (event.key === 'Escape') { event.preventDefault(); onOpenChat() } }
  return <section className="bav-panel bav-settings" onKeyDown={keyDown}>
    <header className="bav-settings-header"><button type="button" className="bav-secondary" onClick={onOpenChat}>← 返回对话</button><h1 ref={headingRef} tabIndex={-1}>设置</h1></header>
    <nav className="bav-settings-nav" aria-label="设置类型">
      <button type="button" className={section === 'agents' ? 'is-active' : ''} aria-current={section === 'agents' ? 'page' : undefined} onClick={() => onSectionChange('agents')}>Agent</button>
      <button type="button" className={section === 'skills' ? 'is-active' : ''} aria-current={section === 'skills' ? 'page' : undefined} onClick={() => onSectionChange('skills')}>技能</button>
      <button type="button" aria-label="模型与 API Key" className={section === 'connections' ? 'is-active' : ''} aria-current={section === 'connections' ? 'page' : undefined} onClick={() => onSectionChange('connections')}>模型</button>
      <button type="button" className={section === 'services' ? 'is-active' : ''} aria-current={section === 'services' ? 'page' : undefined} onClick={() => onSectionChange('services')}>工具服务</button>
    </nav>
    {notice && <p role="status" className={`bav-notice ${notice.kind}`}>{notice.text}</p>}
    {section === 'agents' && <AgentEditor client={client} snapshot={snapshot} report={report} preferredConnectionId={preferredConnectionId} onManageConnection={() => onSectionChange('connections')} onOpenChat={onOpenChat} />}
    {section === 'skills' && <SkillEditor client={client} skills={snapshot.skills} report={report} />}
    {section === 'connections' && <ConnectionEditor client={client} connections={snapshot.connections} report={report} onCreateAgent={useConnection} />}
    {section === 'services' && <OcrSettings client={client} configured={snapshot.ocr?.credentialConfigured ?? false} report={report} />}
  </section>
}

export function errorText(value: unknown): string { return value instanceof Error ? value.message : '操作失败，请重试' }
