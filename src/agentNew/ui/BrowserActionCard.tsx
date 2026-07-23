// 浏览器动作卡片（P8-e）——纯展示，无交互。
// ---------------------------------------------------------------------------
// 契约（U1）：本组件不读 atom、不 import 命令、不碰 store —— card 由父组件当 prop 传入。
// 新 BrowserCard 已简化为 { id; createdAt; title; body? }（无 items/options/按钮）：
//   · 渲染 title 作标题；
//   · 有 body 时用 react-markdown 渲染正文（与 MessageList 一致），无 body 不渲染正文区。

import ReactMarkdown from 'react-markdown'
import type { BrowserCard } from '@web-agent/core/state/transientAtoms'

export function BrowserActionCard({ card }: { card: BrowserCard }) {
  return (
    <div className="agentnew-browser-card" aria-label="浏览器动作卡片">
      <div className="agentnew-browser-card-title">{card.title}</div>
      {card.body ? (
        <div className="agentnew-browser-card-body">
          <ReactMarkdown>{card.body}</ReactMarkdown>
        </div>
      ) : null}
    </div>
  )
}
