// 两栏骨架（类 codex app · U4）。左＝对话列表，右＝当前对话内容。
// ---------------------------------------------------------------------------
// P-U6a：把已完成的真组件装进两栏 —— 左栏 SessionList（读 rootStore.sessionsAtom），
// 右栏 ActiveSessionProvider 切到「当前会话 store」，内含 MessageList / CheckpointBar /
// Composer。本组件只做组装（U4）：不读 atom、不调命令，那些都在各子组件内部。
// 布局用 className；样式在 agentnew.css（由 main.tsx 统一 import，本文件不 import）。

import { ActiveSessionProvider } from './ActiveSessionProvider'
import { SessionList } from './SessionList'
import { MessageList } from './MessageList'
import { SaveArtifact } from './SaveArtifact'
import { CheckpointBar } from './CheckpointBar'
import { AskUserQuestionCard } from './AskUserQuestionCard'
import { Composer } from './Composer'

export function AppShell() {
  return (
    <div className="agentnew-shell">
      <aside className="agentnew-sidebar" aria-label="对话列表">
        <SessionList />
      </aside>
      <main className="agentnew-main" aria-label="当前对话">
        <ActiveSessionProvider>
          {/* SaveArtifact 属于「当前对话内容」的一部分，排在 MessageList 之后、CheckpointBar 之前。 */}
          <MessageList />
          <SaveArtifact />
          <CheckpointBar />
          {/* AskUserQuestionCard 是暂停提问卡片，紧贴输入区上方（最显眼），排在 Composer 之前。 */}
          <AskUserQuestionCard />
          <Composer />
        </ActiveSessionProvider>
      </main>
    </div>
  )
}
