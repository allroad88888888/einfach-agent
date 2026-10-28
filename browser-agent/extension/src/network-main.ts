import { createWindowNetworkHost, installWindowNetworkRecorder } from '@einfach-agent/tools-browser-network'
import type { NetworkMethod } from './protocol'

type NetworkHost = ReturnType<typeof createWindowNetworkHost>
type Gateway = {
  call(sessionId: string, targetId: string, documentId: string, requestId: string, method: NetworkMethod, input: unknown): Promise<unknown>
  cancel(sessionId: string, requestId: string): void
  dispose(): void
}
type Lifecycle = { version?: number; resume(): void; dispose(): void }

const key = '__einfachBrowserAgentNetworkGateway__'
const lifecycleKey = '__einfachBrowserAgentNetworkLifecycle__'
const lifecycleVersion = 4
const scope = globalThis as typeof globalThis & { [key]?: Gateway; [lifecycleKey]?: Lifecycle }

if (scope[lifecycleKey]?.version === lifecycleVersion) scope[lifecycleKey].resume()
else {
  scope[lifecycleKey]?.dispose()
  delete scope[key]
  delete scope[lifecycleKey]
  let releaseCurrent: (() => void) | undefined
  const installGateway = () => {
    if (scope[key]) return
    const recorder = installWindowNetworkRecorder({ window, maxRequests: 100, maxBodyChars: 32 * 1024, retainForDocument: true })
    const hosts = new Map<string, { documentId: string; host: NetworkHost }>()
    const active = new Map<string, AbortController>()
    releaseCurrent = () => {
      for (const { host } of hosts.values()) host.dispose()
      hosts.clear(); recorder.dispose(); delete scope[key]; releaseCurrent = undefined
    }
    scope[key] = {
      async call(sessionId, targetId, documentId, requestId, method, input) {
        let entry = hosts.get(sessionId)
        if (entry && entry.documentId !== documentId) {
          for (const [key, controller] of active) if (key.startsWith(`${sessionId}:`)) controller.abort()
          entry.host.dispose(); entry = undefined
        }
        if (!entry) { entry = { documentId, host: createWindowNetworkHost({ window, targetId, documentId }) }; hosts.set(sessionId, entry) }
        const host = entry.host
        const controller = new AbortController()
        active.set(`${sessionId}:${requestId}`, controller)
        const ctx = { sessionId, signal: controller.signal }
        try {
          if (method === 'startCapture') return await host.startCapture(input as never, ctx)
          if (method === 'stopCapture') return await host.stopCapture(input as never, ctx)
          if (method === 'listRequests') return await host.listRequests(input as never, ctx)
          if (method === 'getRequest') return await host.getRequest(input as never, ctx)
          if (method === 'getResponse') return await host.getResponse(input as never, ctx)
          if (method === 'waitForRequest') return await host.waitForRequest(input as never, ctx)
          throw new Error('Unknown network method.')
        } finally { active.delete(`${sessionId}:${requestId}`) }
      },
      cancel(sessionId, requestId) { active.get(`${sessionId}:${requestId}`)?.abort() },
      dispose() { lifecycle.dispose() },
    }
  }
  const onPagehide = () => { releaseCurrent?.() }
  const onPageshow = (event: Event) => { if ((event as PageTransitionEvent).persisted) installGateway() }
  const lifecycle: Lifecycle = {
    version: lifecycleVersion,
    resume: installGateway,
    dispose() {
      releaseCurrent?.()
      removeEventListener('pagehide', onPagehide)
      removeEventListener('pageshow', onPageshow)
      delete scope[lifecycleKey]
    },
  }
  scope[lifecycleKey] = lifecycle
  addEventListener('pagehide', onPagehide)
  addEventListener('pageshow', onPageshow)
  installGateway()
}
