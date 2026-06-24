import React from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from '@einfach/react'
import { agentStore } from './agent/state/atoms'
import { hydrateFromStorage, IndexedDbDriver } from './agent/state/persistence'
import { ChatShell } from './chat/ChatShell'
import './styles/global.css'

function mount() {
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Provider store={agentStore}>
        <ChatShell />
      </Provider>
    </React.StrictMode>,
  )
}

// Hydrate persisted state first, then render. Persistence failures must never
// block the app from starting.
hydrateFromStorage(agentStore, new IndexedDbDriver())
  .catch(() => undefined)
  .finally(mount)
