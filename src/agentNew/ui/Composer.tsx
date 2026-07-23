// P-U4 Composer：右栏输入框，挂在「当前会话 store」的 Provider 下。
// ---------------------------------------------------------------------------
// 契约（RUNTIME-UI-PLAN §1）：
//   · U1 runtime/UI 隔离：本组件只做两件事 —— 读 atom（runAtom 判忙碌）+ 调命令
//     （sendMessage / stopRun / withdrawCurrentTurnToDraft）。草稿是会话内 transient UI 态。
//   · U7 esc 中断：运行中 Escape → stopRun；输入框空闲 Escape → 清空当前会话草稿。
// 草稿是会话内 transient atom，不持久化、不进 model messages。

import { useEffect, useRef } from 'react'
import { useAtomValue, useSetAtom } from '@einfach/react'
import { runAtom } from '@web-agent/core/state/sessionAtoms'
import { composerDraftAtom, withdrawnTurnNoticeAtom } from '@web-agent/core/state/transientAtoms'
import { sendMessage, stopRun, withdrawCurrentTurnToDraft } from '@web-agent/core/runtime/commands'

export function Composer() {
  const composingRef = useRef(false)
  const run = useAtomValue(runAtom)
  const draft = useAtomValue(composerDraftAtom)
  const notice = useAtomValue(withdrawnTurnNoticeAtom)
  const setDraft = useSetAtom(composerDraftAtom)
  const setNotice = useSetAtom(withdrawnTurnNoticeAtom)
  const running = run?.status === 'running'
  const stopped = run?.status === 'stopped'
  // waiting_user（等 ask_user 回答）/ waiting_confirmation（等危险工具确认，S4-B）也锁输入：此时应走
  //   卡片的「继续/允许/拒绝」，不能发新消息顶掉暂停中的 run —— 否则暂停中的 tool_call 无 tool result，
  //   重发构成非法 tool-call 序列（codex P2）。
  const paused = run?.status === 'waiting_user'
    || run?.status === 'waiting_confirmation'
    || run?.status === 'waiting_plan_approval'
  const locked = running || paused

  const send = () => {
    if (!draft.trim() || locked) return
    sendMessage(draft.trim())
    setDraft('')
    setNotice(undefined)
  }

  const updateDraft = (value: string) => {
    setDraft(value)
    if (notice) setNotice(undefined)
  }

  // U7：全局 Esc 中断当前 run —— 挂在 window 上，焦点不在输入框时也生效。
  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (composingRef.current || event.isComposing) return
      const target = event.target
      const inComposerInput =
        target instanceof HTMLTextAreaElement && target.classList.contains('agentnew-composer-input')
      if (inComposerInput && !running) {
        event.preventDefault()
        setDraft('')
        if (notice) setNotice(undefined)
        return
      }
      stopRun()
    }
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [notice, running, setDraft, setNotice])

  return (
    <div className="agentnew-composer">
      {notice ? (
        <div className={notice.sideEffects ? 'agentnew-withdraw-notice warning' : 'agentnew-withdraw-notice'}>
          {notice.text}
        </div>
      ) : null}
      {stopped ? (
        <div className="agentnew-withdraw-bar">
          <span>已停止</span>
          <button type="button" className="agentnew-withdraw-button" onClick={withdrawCurrentTurnToDraft}>
            撤回并编辑
          </button>
        </div>
      ) : null}
      <textarea
        className="agentnew-composer-input"
        value={draft}
        disabled={locked}
        onChange={(event) => updateDraft(event.target.value)}
        onCompositionStart={() => {
          composingRef.current = true
        }}
        onCompositionEnd={() => {
          composingRef.current = false
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            // IME 组合中（拼音选字等）的 Enter 是确认候选词，不是发送消息。
            if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return
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
