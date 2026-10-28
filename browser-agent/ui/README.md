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

每条仍有完整事务记录的用户消息都可撤销，撤销后原话回填并聚焦输入框。正常新会话不按消息年龄或
事务数淘汰记录；旧版本已经丢失或损坏的账本只显示真实的不可用诊断，不伪造可恢复状态。

对话顶部的“历史”直接打开会话列表，按最近活动分组，可按标题或 Agent 搜索并切换。列表临时替换
聊天区域；返回或按 Escape 可继续原对话。当前 client 的活动会话是唯一选择来源，切换不会停止运行，
各会话草稿在当前视图生命周期内独立保留。历史支持搜索页面标题与网址，并显示已绑定页面的标题和域名。

输入框左侧的回形针支持多选、拖入或粘贴附件。文件以紧凑卡片显示，可单独移除；只有附件也可以发送。
目前支持 TXT、CSV、TSV、JSON、JSONL、Markdown、日志及常见文本代码文件（UTF-8，或带 BOM 的 UTF-16）。
最多 6 个文件，文本单个 256 KB、文本合计 512 KB，消息和附件文本合计最多 10 万字符。
另支持 PDF、PNG、JPEG、WebP、GIF，通过 `paddle_ocr` 提取文字，每个最多 20 MB，所有附件合计最多 40 MB。
先在“设置 → 工具服务”配置 OCR Token，并在 Agent 工具能力中选择 `paddle_ocr` 后新建会话。
PDF/图片先随会话保存在浏览器，工具调用时才上传 PaddleOCR。Word 请先导出为 PDF。
选择时仅保留本地 Blob；点击发送后由运行包读取并校验，正文随模型请求发送，文件名和提取文本随会话保存。
发送失败保留草稿；切换会话保留各自附件；撤销后恢复消息和附件。未发送的草稿不跨页面刷新保存。

“新建”先打开 Agent、目标页面（宿主提供时）和可选对话标题的表单。取消不创建历史；创建失败保留输入。
标题留空时由 core 根据首条用户消息命名，也可在历史中手动改名。

宿主可通过 `<BrowserAgentView client={client} pages={sessionPageHost} />` 提供运行包定义的
`SessionPageHost`。视图负责选择、状态显示与重新绑定交互；页面访问、绑定持久化和生命周期由宿主实现。
未提供 `pages` 的嵌入场景只显示 Agent 和标题，不依赖浏览器扩展 API。
提供 `pages` 时，聊天顶部用可展开的一行显示页面；绑定不可用时保留草稿并阻止发送、决策和恢复运行。

每条会话的“•••”提供重命名和删除，搜索旁的“•••”提供清空历史。删除需确认，确认后由运行包的
`client.deleteSessions(ids)` 调用 core 删除命令并等待持久化完成；Agent、技能与模型连接配置保留。
删除当前会话后复用 core 的活动会话回退；全部删除后显示新建入口，不自动生成空会话。

首次使用时，从对话空态的“配置模型与 API Key”进入，填写服务实际提供的接口地址、模型 ID 和 Key，
再按页面提示创建 Agent、选择模型并回到对话创建会话。模型 ID 由服务方定义，视图不会提供猜测的通用清单。
