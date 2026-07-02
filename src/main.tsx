import React from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from '@einfach/react'
import { rootStore } from './agentNew/state/rootStore'
import { configureCommands, newSession } from './agentNew/runtime/commands'
import { configurePersistence } from './agentNew/runtime/persistenceBridge'
import { hydrate } from './agentNew/state/persistence/hydrate'
import { createIndexedDbHistoryDriver } from './agentNew/state/persistence/indexedDbDriver'
import { createSessionsPersistence } from './agentNew/state/persistence/sessionsPersistence'
import { AppShell } from './agentNew/ui/AppShell'
import './styles/global.css'
import './agentNew/ui/agentnew.css'

// 注入 model apiKey（命令层按会话 vendor 取对应 key）。没有 key 时 model 调用会降级为 error。
configureCommands({
  deepseekApiKey: import.meta.env.VITE_DEEPSEEK_API_KEY ?? '',
  glmApiKey: import.meta.env.VITE_GLM_API_KEY ?? '',
})

// 持久化 driver：hydrate（读回）与 configurePersistence（写盘钩子）必须用同一对实例。
const history = createIndexedDbHistoryDriver()
const sessions = createSessionsPersistence()
configurePersistence({ history, sessions })

function renderApp(): void {
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Provider store={rootStore}>
        <AppShell />
      </Provider>
    </React.StrictMode>,
  )
}

// hydrate 先于种子/渲染（RF3 / codex P1）：盘上有会话就恢复，没有才种子一个空会话，避免首次空屏。
// 容错（DK2）：hydrate 内部吞掉一切异常、绝不 reject —— finally 保证无论成败都会渲染。
hydrate({ history, sessions })
  .then((restored) => {
    if (!restored) newSession()
  })
  .finally(renderApp)
