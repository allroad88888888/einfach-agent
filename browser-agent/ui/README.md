# Browser Agent UI

`@einfach-agent/browser-agent-ui` 是可选的 React 视图包。运行配置和会话由
`@einfach-agent/browser-agent` 创建并持有；客户可以只使用运行包和自己的界面。

```tsx
import { createBrowserAgent } from '@einfach-agent/browser-agent'
import { BrowserAgentView } from '@einfach-agent/browser-agent-ui'
import '@einfach-agent/browser-agent-ui/styles.css'

async function mountAgentView() {
  root.render(<p role="status">正在加载 Agent…</p>)
  try {
    const client = await createBrowserAgent({ namespace: 'customer-sidebar', registerTools })
    root.render(<BrowserAgentView client={client} />)
    // 卸载视图不会停止或销毁 client；由宿主在适当时机调用 client.dispose()。
    return client
  } catch (error) {
    const detail = error instanceof Error ? error.message : '未知错误'
    root.render(<p role="alert">Agent 配置加载失败：{detail}</p>)
    return undefined
  }
}

const client = await mountAgentView()
// 宿主退出时：
await client?.dispose()
```

视图不创建网络请求或持久化调用。它只订阅 client 的公开快照，并通过 `client.core` 的实例命令操作正在显示的会话。
API key 输入在提交后会清空，页面只显示连接是否已配置。
