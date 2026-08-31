// 浏览器动作卡片（P8-e）——纯展示，无交互。
// ---------------------------------------------------------------------------
// 契约（U1）：本组件不读 atom、不 import 命令、不碰 store —— card 由父组件当 prop 传入。
// 新 BrowserCard 已简化为 { id; createdAt; title; body? }（无 items/options/按钮）：
//   · 渲染 title 作标题；
//   · 有 body 时复用 MessageMarkdown 渲染正文，无 body 不渲染正文区。

import type { BrowserCard } from '@einfach-agent/core'
import { useLingui } from '@lingui/react/macro'
import { MessageMarkdown } from './MessageMarkdown'

export function BrowserActionCard({ card }: { card: BrowserCard }) {
  const { t } = useLingui()
  return (
    <div className="agentnew-browser-card" aria-label={t`浏览器动作卡片`}>
      <div className="agentnew-browser-card-title">{card.title}</div>
      {card.body ? (
        <div className="agentnew-browser-card-body">
          <MessageMarkdown>{card.body}</MessageMarkdown>
        </div>
      ) : null}
    </div>
  )
}
