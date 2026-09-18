import { useEffect, useState } from 'react'
import { RootStoreProvider } from '@einfach-agent/react-plugin'
import type { BrowserAgentClient } from '@einfach-agent/browser-agent'
import { ChatView } from './chat/ChatView'
import { SettingsView } from './settings/SettingsView'

export interface BrowserAgentViewProps { client: BrowserAgentClient; className?: string }

export function BrowserAgentView({ client, className }: BrowserAgentViewProps) {
  const [snapshot, setSnapshot] = useState(() => client.getSnapshot())
  const [panel, setPanel] = useState<'chat' | 'settings'>('chat')
  useEffect(() => {
    setSnapshot(client.getSnapshot())
    return client.subscribe(() => setSnapshot(client.getSnapshot()))
  }, [client])
  return <RootStoreProvider store={client.core.rootStore}>
    <main className={['browser-agent-view', className].filter(Boolean).join(' ')} aria-label="浏览器 Agent">
      <header className="bav-header"><div><span className="bav-kicker">WORKSPACE AGENT</span><strong>浏览器 Agent</strong></div><span>配置与对话</span></header>
      <nav className="bav-tabs" aria-label="功能区">
        <button type="button" className={panel === 'chat' ? 'is-active' : ''} onClick={() => setPanel('chat')}>对话</button>
        <button type="button" className={panel === 'settings' ? 'is-active' : ''} onClick={() => setPanel('settings')}>配置</button>
      </nav>
      {panel === 'chat' ? <ChatView client={client} agents={snapshot.agents} /> : <SettingsView client={client} snapshot={snapshot} />}
    </main>
  </RootStoreProvider>
}
