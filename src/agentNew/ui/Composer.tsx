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
  const busy = run?.status === 'running'

  const send = () => {
    if (!draft.trim() || busy) return
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
        disabled={busy}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            send()
          }
        }}
      />
      {busy ? (
        <button type="button" className="agentnew-composer-send" onClick={stopRun}>
          停止
        </button>
      ) : (
        <button
          type="button"
          className="agentnew-composer-send"
          onClick={send}
          disabled={!draft.trim()}
        >
          发送
        </button>
      )}
    </div>
  )
}
