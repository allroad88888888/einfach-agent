import React from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from '@einfach/react'
import { agentStore } from './agent/state/atoms'
import { ChatShell } from './chat/ChatShell'
import './styles/global.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Provider store={agentStore}>
      <ChatShell />
    </Provider>
  </React.StrictMode>,
)
