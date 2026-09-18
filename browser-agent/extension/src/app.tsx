import { useEffect, useMemo, useState } from 'react'
import { BrowserAgentView } from '@einfach-agent/browser-agent-ui'
import type { BrowserAgentClient } from '@einfach-agent/browser-agent'
import { activeSessionIdAtom, runAtom } from '@einfach-agent/core'
import { ExtensionPageBridge, bindActiveTab } from './page-bridge'
import type { TargetBinding } from './protocol'

export function ExtensionApp({ client, bridge }: { client: BrowserAgentClient; bridge: ExtensionPageBridge }) {
  const [activeSessionId, setActiveSessionId] = useState(() => client.core.rootStore.getter(activeSessionIdAtom))
  const [target, setTarget] = useState<TargetBinding | undefined>(() => bridge.target(client.core.rootStore.getter(activeSessionIdAtom)))
  const [error, setError] = useState('')
  const wrapped = useMemo<BrowserAgentClient>(() => ({
    ...client,
    async createSession(agentId: string) {
      const binding = await bindActiveTab()
      const sessionId = await client.createSession(agentId)
      bridge.bind(sessionId, binding)
      setTarget(binding)
      setError('')
      return sessionId
    },
  }), [client, bridge])
  useEffect(() => client.core.rootStore.sub(activeSessionIdAtom, () => {
    const sessionId = client.core.rootStore.getter(activeSessionIdAtom)
    setActiveSessionId(sessionId)
    setTarget(bridge.target(sessionId))
  }), [client, bridge])
  async function rebind() {
    if (!activeSessionId) return
    try {
      const run = client.core.sessionAtomScope(activeSessionId).getter(runAtom)
      if (run && ['running', 'awaiting_tool', 'waiting_confirmation', 'waiting_user', 'waiting_plan_approval'].includes(run.status)) throw new Error('Stop or finish the current run before rebinding its page.')
      const binding = await bindActiveTab(); bridge.bind(activeSessionId, binding); setTarget(binding); setError('')
    }
    catch (value) { setError(value instanceof Error ? value.message : 'The page could not be bound.') }
  }
  return <main className="extension-shell">
    <header className="target-bar">
      <div><strong>Page target</strong><span>{target ? `${target.title} · tab ${target.tabId}` : 'Create a session to bind the active tab.'}</span></div>
      <button type="button" disabled={!activeSessionId} onClick={() => void rebind()}>Bind active tab</button>
      {error && <p role="alert">{error}</p>}
    </header>
    <BrowserAgentView client={wrapped} className="extension-agent-view" />
  </main>
}
