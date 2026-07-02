// P-U4 Composer：右栏输入框，挂在「当前会话 store」的 Provider 下。
// ---------------------------------------------------------------------------
// 契约（RUNTIME-UI-PLAN §1）：
//   · U1 runtime/UI 隔离：本组件只做两件事 —— 读 atom（runAtom 判忙碌）+ 调命令
//     （sendMessage / stopRun）。绝不直接 setter atom、不 import writers、不碰 store 实例。
//   · U7 esc 中断：全局 keydown 监听 Escape → stopRun（无论焦点在哪都能中断当前 run）。
// 草稿是纯本地 UI 态（useState），不进 atom。

import { useEffect, useState } from 'react'
import { useAtomValue } from '@einfach/react'
import { runAtom } from '../state/sessionAtoms'
import { sendMessage, stopRun } from '../runtime/commands'

export function Composer() {
  const [draft, setDraft] = useState('')
  const run = useAtomValue(runAtom)
  const running = run?.status === 'running'
  // waiting_user（等 ask_user 回答）/ waiting_confirmation（等危险工具确认，S4-B）也锁输入：此时应走
  //   卡片的「继续/允许/拒绝」，不能发新消息顶掉暂停中的 run —— 否则暂停中的 tool_call 无 tool result，
  //   重发构成非法 tool-call 序列（codex P2）。
  const paused = run?.status === 'waiting_user' || run?.status === 'waiting_confirmation'
  const locked = running || paused

  const send = () => {
    if (!draft.trim() || locked) return
    sendMessage(draft.trim())
    setDraft('')
  }

  // U7：全局 Esc 中断当前 run —— 挂在 window 上，焦点不在输入框时也生效。
  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') stopRun()
    }
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [])

  return (
    <div className="agentnew-composer">
      <textarea
        className="agentnew-composer-input"
        value={draft}
        disabled={locked}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            send()
          }
        }}
      />
      {running ? (
        <button type="button" className="agentnew-composer-send" onClick={stopRun}>
          停止
        </button>
      ) : (
        <button
          type="button"
          className="agentnew-composer-send"
          onClick={send}
          disabled={!draft.trim() || paused}
        >
          发送
        </button>
      )}
    </div>
  )
}
