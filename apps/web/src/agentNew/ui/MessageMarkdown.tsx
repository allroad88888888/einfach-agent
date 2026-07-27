// Markdown 渲染包装（轮次 3 · TM2）——assistant 气泡内容统一走这层。
// ---------------------------------------------------------------------------
// TM1：remark-gfm 插件，补齐表格/删除线/任务列表/自动链接。
// TM2：镜像 ai-components 的 <ReactMarkdown remarkPlugins={[remarkGfm]} components /> 模式，
//      只抄写法、不引其 @ai-components 路径依赖（agentNew 自包含）。
// TM3：组件映射最小集——
//   a     → target="_blank" rel="noopener noreferrer"（Tauri webview 里点链接不得把 app 导航走）
//   table → 外包 .agentnew-md-table-wrap（CSS overflow-x:auto，防止宽表格撑破气泡）
//   其余标签不映射，交给 CSS 处理溢出（TM4）。
// 安全边界：绝不引 rehype-raw / 不开 raw HTML —— react-markdown 默认转义内嵌 HTML，
// 内容里的 <script>/<img onerror=...> 只会以纯文本呈现，不会长成真实 DOM 节点。
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { memo } from 'react'

const components: Components = {
  // props 先展开、target/rel 后置 —— 我们的安全属性恒胜（防御纵深；纯 markdown 本也产不出这俩属性）。
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  table: ({ node, ...props }) => (
    <div className="agentnew-md-table-wrap">
      <table {...props} />
    </div>
  ),
}

export const MessageMarkdown = memo(function MessageMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </ReactMarkdown>
  )
})
