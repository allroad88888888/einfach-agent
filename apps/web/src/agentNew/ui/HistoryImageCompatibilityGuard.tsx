import { useMemo, type ReactNode } from 'react'
import { useAgentAtomValue } from '@einfach-agent/react-plugin'
import { projectHistoryImage, type UserImageContentBlock } from '@einfach-agent/ai'
import { itemsAtom } from '@einfach-agent/core'
import { useHistoryImageTarget } from './HistoryImageCompatibilityContext'
import './HistoryImageCompatibilityGuard.css'

export function HistoryImageCompatibilityGuard({ children }: { children: ReactNode }) {
  const items = useAgentAtomValue(itemsAtom)
  const target = useHistoryImageTarget()
  const incompatibleCount = useMemo(() => {
    let count = 0
    for (const entry of items) {
      if (entry.item.role !== 'user' || typeof entry.item.content === 'string') continue
      for (const block of entry.item.content) {
        if (block.type !== 'image') continue
        if (projectHistoryImage(block as UserImageContentBlock, target).kind === 'placeholder') {
          count += 1
        }
      }
    }
    return count
  }, [items, target])

  if (incompatibleCount === 0) return children
  return (
    <section className="agentnew-history-image-guard">
      <div role="alert" className="agentnew-history-image-warning">
        当前模型无法继续使用对话中的 {incompatibleCount} 张历史图片。
        请切换回兼容模型，或回退并移除相关图片后再发送。
      </div>
      <textarea
        className="agentnew-composer-input"
        aria-label="历史图片不兼容，输入已禁用"
        placeholder="历史图片与当前模型不兼容，暂时无法发送新消息"
        disabled
      />
    </section>
  )
}
