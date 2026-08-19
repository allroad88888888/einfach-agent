// P-U4 Composer：右栏输入框。
// ---------------------------------------------------------------------------
// 当前 UI/runtime 契约：
//   · U1 runtime/UI 隔离：会话状态（run / 排队消息 / 撤回提示）经 useAgentAtomValue 只读，
//     要改只调命令（sendMessage / stopRun / dismissWithdrawnTurnNotice）。
//   · U7 esc 中断：运行中 Escape → stopRun；输入框空闲 Escape → 清空草稿。
// **草稿住 UI store**（composerDraftState.ts）：纯渲染态，刷新即丢，不进恢复快照 ——
// 它曾是槽位，理由是「回退会把用户原话放回输入框」，而那个机制在实现里不存在，详见该文件。

import { useEffect, useRef } from 'react'
import { useAtomValue, useSetAtom } from '@einfach/react'
import { useAgentAtomValue } from '@einfach-agent/react-plugin'
import {
  runAtom,
  queuedUserMessagesAtom,
  withdrawnTurnNoticeAtom,
  continueInterruptedRun,
  dismissWithdrawnTurnNotice,
  sendMessage,
  setApprovalMode,
  stopRun,
} from '@einfach-agent/core'
import { composerDraftAtom } from './composerDraftState'
import {
  addComposerImageAttachmentsAtom,
  beginComposerImageSubmissionAtom,
  clearComposerImageAttachmentsAtom,
  composerImageAttachmentAtom,
  setComposerImageAttachmentErrorAtom,
  settleComposerImageSubmissionAtom,
} from './composerImageAttachmentState'
import { ComposerAttachmentTray } from './ComposerAttachmentTray'
import { composerSubmissionOutcome, isPromiseLike } from './composerSubmissionOutcome'
import { imageInputCapabilityForApp } from '../../modelInput/kimiImageFeature'

function formatRunError(error: string) {
  if (/\b401\b|authentication fails|unauthorized|api[ _-]?key/i.test(error)) {
    return '模型鉴权失败（401），请检查当前模型供应商的 API Key 是否有效。'
  }
  return error
}

export function Composer({
  approvalMode = 'confirm',
  vendor = '',
  model = '',
}: {
  approvalMode?: 'confirm' | 'auto'
  vendor?: string
  model?: string
}) {
  const composingRef = useRef(false)
  const modeShortcutLatchedRef = useRef(false)
  const run = useAgentAtomValue(runAtom)
  const queuedMessages = useAgentAtomValue(queuedUserMessagesAtom)
  const notice = useAgentAtomValue(withdrawnTurnNoticeAtom)
  const draft = useAtomValue(composerDraftAtom)
  const attachments = useAtomValue(composerImageAttachmentAtom)
  const setDraft = useSetAtom(composerDraftAtom)
  const addImages = useSetAtom(addComposerImageAttachmentsAtom)
  const clearImages = useSetAtom(clearComposerImageAttachmentsAtom)
  const beginImageSubmission = useSetAtom(beginComposerImageSubmissionAtom)
  const settleImageSubmission = useSetAtom(settleComposerImageSubmissionAtom)
  const setImageError = useSetAtom(setComposerImageAttachmentErrorAtom)
  const running = run?.status === 'running' || run?.status === 'awaiting_tool'
  const stopped = run?.status === 'stopped'
  const interrupted = run?.status === 'interrupted'
  const runError = run?.status === 'error' ? run.error : undefined
  // waiting_user（等 ask_user 回答）/ waiting_confirmation（等危险工具确认，S4-B）也锁输入：此时应走
  //   卡片的「继续/允许/拒绝」，不能发新消息顶掉暂停中的 run —— 否则暂停中的 tool_call 无 tool result，
  //   重发构成非法 tool-call 序列（codex P2）。
  const paused = run?.status === 'waiting_user'
    || run?.status === 'waiting_confirmation'
    || run?.status === 'waiting_plan_approval'
  const locked = paused || interrupted
  const imageCapability = imageInputCapabilityForApp(vendor, model)
  const preparingImages = attachments.operation !== 'idle'
  const editorDisabled = locked || preparingImages

  const send = () => {
    const text = draft.trim()
    const hasImages = attachments.images.length > 0
    if ((!text && !hasImages) || editorDisabled) return
    if (hasImages && imageCapability.kind !== 'provider-upload') {
      setImageError(imageCapability.reason)
      return
    }
    if (hasImages && !beginImageSubmission()) return
    const settle = (value: unknown) => {
      const outcome = composerSubmissionOutcome(value)
      if (hasImages) settleImageSubmission({ revision: attachments.revision, ...outcome })
      if (outcome.accepted) {
        setDraft('')
        dismissWithdrawnTurnNotice()
      }
    }
    const input = !hasImages
      ? text
      : {
          text,
          images: attachments.images.map((image) => ({
            id: image.id,
            name: image.name,
            mimeType: image.mimeType,
            byteSize: image.byteSize,
            width: image.width,
            height: image.height,
            data: image.file,
          })),
        }
    const result = sendMessage(input)
    if (isPromiseLike(result)) {
      void result.then(settle, (error) => settle({ accepted: false, error: error instanceof Error ? error.message : undefined }))
      return
    }
    // 保留同步 command mock 的兼容路径；真实 Core command 总是返回 Promise。
    settle(result)
  }

  const updateDraft = (value: string) => {
    setDraft(value)
    if (notice) dismissWithdrawnTurnNotice()
  }

  const toggleApprovalMode = () => {
    setApprovalMode(approvalMode === 'auto' ? 'confirm' : 'auto')
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
        clearImages()
        if (notice) dismissWithdrawnTurnNotice()
        return
      }
      stopRun()
    }
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [clearImages, notice, running, setDraft])

  // 焦点变化时 textarea 可能收不到 keyup；在 window 兜底解锁下一次快捷键按压。
  useEffect(() => {
    const releaseShortcut = (event: KeyboardEvent) => {
      if (event.key === 'Shift' || event.key === 'Tab') modeShortcutLatchedRef.current = false
    }
    const releaseOnBlur = () => {
      modeShortcutLatchedRef.current = false
    }
    window.addEventListener('keyup', releaseShortcut)
    window.addEventListener('blur', releaseOnBlur)
    return () => {
      window.removeEventListener('keyup', releaseShortcut)
      window.removeEventListener('blur', releaseOnBlur)
    }
  }, [])

  return (
    <div
      className="agentnew-composer"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault()
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        const files = Array.from(event.dataTransfer.files)
        if (editorDisabled || files.length === 0) return
        void addImages({ files, capability: imageCapability })
      }}
    >
      {notice ? (
        <div className={notice.sideEffects ? 'agentnew-withdraw-notice warning' : 'agentnew-withdraw-notice'}>
          {notice.text}
        </div>
      ) : null}
      {runError ? (
        <div className="agentnew-run-error" role="alert">
          <strong>请求失败</strong>
          <span>{formatRunError(runError)}</span>
          {formatRunError(runError) !== runError ? (
            <details>
              <summary>错误详情</summary>
              <code>{runError}</code>
            </details>
          ) : null}
        </div>
      ) : null}
      {stopped ? (
        <div className="agentnew-withdraw-bar">
          <span>已停止</span>
        </div>
      ) : null}
      {interrupted ? (
        <div className="agentnew-withdraw-bar">
          <span>应用重启中断了任务</span>
          <button type="button" className="agentnew-withdraw-button" onClick={continueInterruptedRun}>
            继续执行
          </button>
        </div>
      ) : null}
      <div className="agentnew-composer-editor">
        <div className="agentnew-composer-status-line">
          <button
            type="button"
            className={`agentnew-composer-mode ${approvalMode === 'auto' ? 'is-auto' : ''}`}
            aria-label={`授权模式：${approvalMode === 'auto' ? 'Auto' : '确认'}，Shift+Tab 切换`}
            title="点击或按 Shift + Tab 切换授权模式"
            onClick={toggleApprovalMode}
          >
            授权：{approvalMode === 'auto' ? 'Auto' : '确认'}
            <span aria-hidden="true"> · ⇧Tab 切换</span>
          </button>
          {queuedMessages.length > 0 ? (
            <span className="agentnew-composer-queue-status" role="status">
              已排队 {queuedMessages.length} 条
            </span>
          ) : null}
        </div>
        <textarea
          id="agentnew-composer-input"
          name="message"
          aria-label="消息"
          className="agentnew-composer-input"
          value={draft}
          disabled={editorDisabled}
          onChange={(event) => updateDraft(event.target.value)}
          onCompositionStart={() => {
            composingRef.current = true
          }}
          onCompositionEnd={() => {
            composingRef.current = false
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files)
            if (editorDisabled || files.length === 0) return
            event.preventDefault()
            void addImages({ files, capability: imageCapability })
          }}
          onKeyDown={(event) => {
            if (event.key === 'Tab' && event.shiftKey && !modeShortcutLatchedRef.current) {
              event.preventDefault()
              modeShortcutLatchedRef.current = true
              toggleApprovalMode()
              return
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              // IME 组合中（拼音选字等）的 Enter 是确认候选词，不是发送消息。
              if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return
              event.preventDefault()
              send()
            }
          }}
          onKeyUp={(event) => {
            if (event.key === 'Shift' || event.key === 'Tab') modeShortcutLatchedRef.current = false
          }}
        />
        <ComposerAttachmentTray
          capability={imageCapability}
          disabled={editorDisabled}
          onFiles={(files) => void addImages({ files, capability: imageCapability })}
        />
      </div>
      <div className="agentnew-composer-actions">
        <button
          type="button"
          className="agentnew-composer-send"
          onClick={send}
          disabled={(!draft.trim() && attachments.images.length === 0) || editorDisabled}
        >
          {preparingImages ? '准备图片…' : running ? '加入队列' : '发送'}
        </button>
        {running ? (
          <button
            type="button"
            className="agentnew-composer-send agentnew-composer-stop"
            // 包一层而不是直接传 stopRun：它现在收一个 options 对象，直接传会把 MouseEvent
            // 当选项塞进去（`event.disposeUserContent` 是 undefined，行为上恰好没变，但纯属巧合）。
            onClick={() => { stopRun() }}
          >
            停止
          </button>
        ) : null}
      </div>
    </div>
  )
}
