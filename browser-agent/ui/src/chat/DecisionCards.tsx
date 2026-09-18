import type { BrowserAgentClient } from '@einfach-agent/browser-agent'
import type { AskUserAnswerValue, RunState } from '@einfach-agent/core'
import { normalizeAskUserQuestionPayload, type AskUserQuestionItem } from '@einfach-agent/core/tools'

export function DecisionCards({ client, sessionId, run, answers }: { client: BrowserAgentClient; sessionId: string; run: RunState | undefined; answers: Readonly<Record<string, AskUserAnswerValue>> }) {
  if (run?.status === 'waiting_confirmation') {
    const pending = run.pendingToolConfirmation
    return <section className="bav-decision" aria-label="工具确认"><span className="bav-eyebrow">等待确认</span><h3>{pending?.toolName ?? '工具调用'}</h3>{pending?.reason && <p>{pending.reason}</p>}<dl><dt>参数</dt><dd><pre>{format(pending?.args)}</pre></dd>{pending?.risk && <><dt>风险</dt><dd>{pending.risk === 'critical' ? '高风险' : '需要确认'}</dd></>}</dl><div className="bav-actions"><button type="button" className="bav-danger" onClick={() => client.core.confirmTool(false, false, sessionId)}>拒绝</button><button type="button" onClick={() => client.core.confirmTool(true, false, sessionId)}>允许本次调用</button></div></section>
  }
  if (run?.status !== 'waiting_user') return null
  const payload = normalizeAskUserQuestionPayload(run.pendingUserDecision?.payload ?? run.pendingQuestion)
  const required = payload.questions.filter((question) => question.required)
  const ready = required.every((question) => answered(answers[question.id]))
  return <section className="bav-decision" aria-label="确认问题"><span className="bav-eyebrow">运行已暂停</span><h3>{payload.title ?? '需要你的答复'}</h3>{payload.questions.length ? payload.questions.map((question) => <Question key={question.id} question={question} value={answers[question.id]} onChange={(value) => client.core.answerQuestion(question.id, value, sessionId)} />) : <p className="bav-error">问题内容无法显示。你仍可继续，让 Agent 重新处理。</p>}<div className="bav-decision-footer"><span>{ready ? '答复后将继续运行' : '请完成必填项'}</span><button type="button" disabled={!ready} onClick={() => client.core.resumeWithAnswers(sessionId)}>继续</button></div></section>
}

function Question({ question, value, onChange }: { question: AskUserQuestionItem; value: AskUserAnswerValue | undefined; onChange(value: AskUserAnswerValue): void }) {
  if (question.type === 'text') return <label className="bav-question">{question.text}{question.required && <span aria-label="必填"> *</span>}<textarea value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value)} /></label>
  const options = question.type === 'confirm' ? [['是', true], ['否', false]] as const : (question.options ?? []).map((option) => [option, option] as const)
  const selected = Array.isArray(value) ? value : []
  return <fieldset className="bav-question"><legend>{question.text}{question.required && <span aria-label="必填"> *</span>}</legend><div className="bav-choice-list">{options.map(([label, option]) => { const active = question.type === 'multi-choice' ? selected.includes(String(option)) : value === option; return <button type="button" key={String(option)} aria-pressed={active} onClick={() => question.type === 'multi-choice' ? onChange(active ? selected.filter((item) => item !== option) : [...selected, String(option)]) : onChange(option)}>{label}</button> })}</div></fieldset>
}

function answered(value: AskUserAnswerValue | undefined): boolean { return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== '' }
function format(value: unknown): string { try { return JSON.stringify(value, null, 2) } catch { return String(value) } }
