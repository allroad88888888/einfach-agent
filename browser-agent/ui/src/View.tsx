import { useEffect, useRef, useState } from 'react'
import { RootStoreProvider } from '@einfach-agent/react-plugin'
import type { BrowserAgentClient, SessionPageHost } from '@einfach-agent/browser-agent'
import { ChatView } from './chat/ChatView'
import { SettingsView, type SettingsSection } from './settings/SettingsView'

export interface BrowserAgentViewProps { client: BrowserAgentClient; className?: string; pages?: SessionPageHost }

const clientKeys = new WeakMap<BrowserAgentClient, number>()
let nextClientKey = 1

export function BrowserAgentView({ client, className, pages }: BrowserAgentViewProps) {
  let clientKey = clientKeys.get(client)
  if (!clientKey) { clientKey = nextClientKey++; clientKeys.set(client, clientKey) }
  return <RootStoreProvider store={client.core.rootStore}>
    <BrowserAgentWorkspace key={clientKey} client={client} className={className} pages={pages} />
  </RootStoreProvider>
}

function BrowserAgentWorkspace({ client, className, pages }: BrowserAgentViewProps) {
  const [snapshot, setSnapshot] = useState(() => client.getSnapshot())
  const [activeView, setActiveView] = useState<'chat' | 'settings'>('chat')
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('agents')
  const settingsButtonRef = useRef<HTMLButtonElement>(null)
  const settingsHeadingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    setSnapshot(client.getSnapshot())
    return client.subscribe(() => setSnapshot(client.getSnapshot()))
  }, [client])
  function openSettings(section: typeof settingsSection = 'agents') {
    setSettingsSection(section)
    setActiveView('settings')
    requestAnimationFrame(() => settingsHeadingRef.current?.focus())
  }
  function openChat() {
    setActiveView('chat')
    requestAnimationFrame(() => settingsButtonRef.current?.focus())
  }
  return <main className={['browser-agent-view', className].filter(Boolean).join(' ')} aria-label="浏览器 Agent">
    <div hidden={activeView !== 'chat'} className="bav-view-slot"><ChatView client={client} agents={snapshot.agents} pages={pages} onConfigure={() => openSettings('connections')} onOpenSettings={() => openSettings()} settingsButtonRef={settingsButtonRef} /></div>
    {activeView === 'settings' && <SettingsView client={client} snapshot={snapshot} section={settingsSection} onSectionChange={setSettingsSection} onOpenChat={openChat} headingRef={settingsHeadingRef} />}
  </main>
}
