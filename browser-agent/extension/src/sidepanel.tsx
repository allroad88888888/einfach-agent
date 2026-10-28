import { createRoot } from 'react-dom/client'
import { createBrowserAgent } from '@einfach-agent/browser-agent'
import { createApiToolsHost, registerApiTools } from '@einfach-agent/tools-browser-api'
import { registerDomTools } from '@einfach-agent/tools-browser-dom'
import { registerPageTools } from '@einfach-agent/tools-browser-page'
import { registerNetworkTools } from '@einfach-agent/tools-browser-network'
import { ExtensionApp } from './app'
import { ExtensionPageBridge } from './page-bridge'
import { ExtensionNetworkBridge } from './network-bridge'
import '@einfach-agent/browser-agent-ui/styles.css'
import './sidepanel.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing sidepanel root')
void mount().catch((error) => renderInitializationError(error))

async function mount(): Promise<void> {
  const bridge = new ExtensionPageBridge()
  const networkBridge = new ExtensionNetworkBridge(bridge)
  const apiHost = createApiToolsHost([], { isSourceAllowed: () => false })
  const client = await createBrowserAgent({
    namespace: 'extension',
    registerTools(registry) { registerPageTools(registry, bridge); registerDomTools(registry, bridge); registerApiTools(registry, apiHost); registerNetworkTools(registry, networkBridge) },
  })
  await bridge.restore(client.core.sessionIds())
  addEventListener('pagehide', () => { void Promise.allSettled([networkBridge.dispose(), client.dispose({ preserveRecovery: true })]) }, { once: true })
  createRoot(root!).render(<ExtensionApp client={client} bridge={bridge} />)
}

function renderInitializationError(error: unknown): void {
  const message = error instanceof Error ? error.message : 'Unknown initialization error'
  root!.innerHTML = `<main class="initialization-error" role="alert"><h1>Browser Agent could not start</h1><p></p><button type="button">Retry</button></main>`
  root!.querySelector('p')!.textContent = message
  root!.querySelector('button')!.addEventListener('click', () => location.reload())
}
