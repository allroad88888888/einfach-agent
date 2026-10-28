import { useEffect, useMemo } from 'react'
import { BrowserAgentView } from '@einfach-agent/browser-agent-ui'
import type { BrowserAgentClient } from '@einfach-agent/browser-agent'
import { runAtom, sessionsAtom } from '@einfach-agent/core'
import type { ExtensionPageBridge } from './page-bridge'
import { createSessionPageHost } from './session-page-host'

export function ExtensionApp({ client, bridge }: { client: BrowserAgentClient; bridge: ExtensionPageBridge }) {
  const pages = useMemo(() => createSessionPageHost(client, bridge), [client, bridge])
  useEffect(() => {
    const unwatch = bridge.watch()
    const unsubscribe = bridge.subscribe(() => {
      for (const id of client.core.sessionIds()) {
        if (bridge.context(id)?.status === 'ready') continue
        const run = client.core.sessionAtomScope(id).getter(runAtom)
        if (run && ['running', 'awaiting_tool', 'waiting_confirmation', 'waiting_user', 'waiting_plan_approval'].includes(run.status)) client.core.stopRun({ sessionId: id })
      }
    })
    let previous = new Set(Object.keys(client.core.rootStore.getter(sessionsAtom)))
    const deleted = client.core.rootStore.sub(sessionsAtom, () => {
      const current = new Set(Object.keys(client.core.rootStore.getter(sessionsAtom)))
      for (const id of previous) if (!current.has(id)) void bridge.unbind(id).catch(() => {})
      previous = current
    })
    return () => { unwatch(); unsubscribe(); deleted() }
  }, [client, bridge])
  return <BrowserAgentView client={client} pages={pages} className="extension-agent-view" />
}
