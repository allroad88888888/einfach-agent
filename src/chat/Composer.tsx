import type { KeyboardEvent } from 'react'
import { Textarea } from '@ai-components/textarea-base'
import { useAtom, useAtomValue, useStore } from '@einfach/react'
import { canStopAtom, composerDraftAtom, isBusyAtom } from '../agent/state/atoms'
import { startAgentRun, stopActiveRun } from '../agent/runtime/loop'

export function Composer() {
  const [draft, setDraft] = useAtom(composerDraftAtom)
  const isBusy = useAtomValue(isBusyAtom)
  const canStop = useAtomValue(canStopAtom)
  const store = useStore()
  const canSend = draft.trim().length > 0 && !isBusy

  const send = () => {
    if (!canSend) return
    startAgentRun(store, draft)
  }

  const handlePressEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.shiftKey) return
    event.preventDefault()
    send()
  }

  return (
    <footer className={`composer agent-composer agent-composer--${isBusy ? 'busy' : 'ready'}`}>
      <div className="composer-input agent-composer-input">
        <Textarea
          value={draft}
          disabled={isBusy}
          autoSize={{ minRows: 1, maxRows: 7 }}
          placeholder={isBusy ? 'Agent running' : '输入任务'}
          onChange={setDraft}
          onPressEnter={handlePressEnter}
          className="composer-textarea agent-composer-textarea"
        />
      </div>
      <div className="composer-actions agent-composer-actions">
        <button
          className="secondary-button composer-button composer-button--stop agent-composer-button agent-composer-button--stop"
          disabled={!canStop}
          onClick={() => stopActiveRun(store)}
        >
          停止
        </button>
        <button
          className="primary-button composer-button composer-button--send agent-composer-button agent-composer-button--send"
          disabled={!canSend}
          onClick={send}
        >
          发送
        </button>
      </div>
    </footer>
  )
}
