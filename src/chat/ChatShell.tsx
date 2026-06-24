import { useAtomValue } from '@einfach/react'
import { activeRunAtom, activeSessionAtom } from '../agent/state/atoms'
import type { RunStatus } from '../agent/runtime/types'
import { AskUserQuestionCard } from './AskUserQuestionCard'
import { Composer } from './Composer'
import { MessageList } from './MessageList'
import { RunActivity } from './RunActivity'
import { ToolTimeline } from './ToolTimeline'

const statusLabels: Record<RunStatus, string> = {
  idle: '就绪',
  running: '执行中',
  waiting_user: '等待确认',
  done: '已完成',
  stopped: '已停止',
  error: '出错',
}

export function ChatShell() {
  const session = useAtomValue(activeSessionAtom)
  const run = useAtomValue(activeRunAtom)
  const status = run?.status ?? session.status

  return (
    <div className={`agent-shell agent-console agent-console--${status}`}>
      <main className="chat-pane agent-console-main" aria-label="Agent 对话控制台">
        <header className={`chat-header agent-console-header agent-console-header--${status}`}>
          <div className="chat-header-main agent-console-header-main">
            <h1 className="chat-title agent-console-title">{session.title}</h1>
            <p className="chat-subtitle agent-console-subtitle">
              浏览器运行时 · Einfach 状态 · ai-components 渲染
            </p>
          </div>
          <span className={`status-pill status-${status} chat-status agent-console-status`}>
            {statusLabels[status]}
          </span>
        </header>
        <MessageList />
        <RunActivity />
        <AskUserQuestionCard />
        <Composer />
      </main>
      <ToolTimeline />
    </div>
  )
}
