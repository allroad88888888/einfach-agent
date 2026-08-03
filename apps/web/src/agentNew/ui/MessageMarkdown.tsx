import { lazy, memo, Suspense } from 'react'

const MarkdownContent = lazy(() => import('./MarkdownContent').then((module) => ({
  default: module.MarkdownContent,
})))

/** Loads the GFM renderer when a conversation first needs rich message content. */
export const MessageMarkdown = memo(function MessageMarkdown({ children }: { children: string }) {
  return (
    <Suspense fallback={<span>{children}</span>}>
      <MarkdownContent>{children}</MarkdownContent>
    </Suspense>
  )
})
