// Renders GFM message content while keeping untrusted HTML escaped.
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const components: Components = {
  // Security attributes override any Markdown-provided values.
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  table: ({ node, ...props }) => (
    <div className="agentnew-md-table-wrap">
      <table {...props} />
    </div>
  ),
}

/** Renders an agent message with the hardened GFM Markdown configuration. */
export function MarkdownContent({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {children}
    </ReactMarkdown>
  )
}
