import { createRoot } from 'react-dom/client'
import { createBrowserAgent } from '@einfach-agent/browser-agent'
import { createApiToolsHost, registerApiTools, type OptionsSource } from '@einfach-agent/tools-browser-api'
import { registerPageTools } from '@einfach-agent/tools-browser-page'
import { ExtensionApp } from './app'
import { ExtensionPageBridge } from './page-bridge'
import '@einfach-agent/browser-agent-ui/styles.css'
import './sidepanel.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing sidepanel root')
void mount().catch((error) => renderInitializationError(error))

async function mount(): Promise<void> {
  const bridge = new ExtensionPageBridge()
  const fixtureSource: OptionsSource = {
    id: 'fixture-cities',
    async query(input, ctx) {
      if (ctx.signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const country = String(input.parameters?.country ?? '')
      const all = country === 'CN' ? [{ label: 'Shanghai', value: 'shanghai' }, { label: 'Beijing', value: 'beijing' }] : [{ label: 'London', value: 'london' }]
      const query = input.query?.toLowerCase()
      return { options: query ? all.filter((item) => item.label.toLowerCase().includes(query)) : all }
    },
  }
  const apiHost = createApiToolsHost([fixtureSource], { isSourceAllowed: (sourceId, sessionId) => sourceId === 'fixture-cities' && Boolean(bridge.target(sessionId)) })
  const client = await createBrowserAgent({
    namespace: 'extension',
    registerTools(registry) { registerPageTools(registry, bridge); registerApiTools(registry, apiHost) },
  })
  await bridge.restore(client.core.sessionIds())
  addEventListener('pagehide', () => { void client.dispose({ preserveRecovery: true }) }, { once: true })
  createRoot(root!).render(<ExtensionApp client={client} bridge={bridge} />)
}

function renderInitializationError(error: unknown): void {
  const message = error instanceof Error ? error.message : 'Unknown initialization error'
  root!.innerHTML = `<main class="initialization-error" role="alert"><h1>Browser Agent could not start</h1><p></p><button type="button">Retry</button></main>`
  root!.querySelector('p')!.textContent = message
  root!.querySelector('button')!.addEventListener('click', () => location.reload())
}
