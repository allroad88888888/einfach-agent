// 右栏消息列表（P-U3）——在「当前会话 store」的 Provider 下，读 itemsAtom 渲染。
// ---------------------------------------------------------------------------
// 契约（U1）：UI 只读 atom + 调命令，本组件只读 itemsAtom（不 setter、不碰 store、不 import 命令）。
// 只渲染对话可见的两类角色：user（纯文本气泡）、assistant（走 react-markdown）。
// system / tool 是「发给/来自模型」的内部条目（系统提示、工具结果回填），对用户不可见，跳过。
// 空列表给一个占位，提示开始对话。

import { useAtomValue } from '@einfach/react'
import ReactMarkdown from 'react-markdown'
import { itemsAtom } from '../state/sessionAtoms'

export function MessageList() {
  const items = useAtomValue(itemsAtom)

  if (items.length === 0) {
    return <div className="agentnew-message-empty">开始对话吧</div>
  }

  return (
    <div className="agentnew-message-list">
      {items.map((ci) => {
        const { item } = ci
        if (item.role === 'user') {
          return (
            <div key={ci.id} className="agentnew-msg agentnew-msg--user">
              {item.content}
            </div>
          )
        }
        if (item.role === 'assistant') {
          // assistant.content 可能为 null（纯工具调用轮）——兜底成空串再交给 markdown。
          return (
            <div key={ci.id} className="agentnew-msg agentnew-msg--assistant">
              <ReactMarkdown>{item.content ?? ''}</ReactMarkdown>
            </div>
          )
        }
        // system / tool：内部消息，不渲染。
        return null
      })}
    </div>
  )
}
