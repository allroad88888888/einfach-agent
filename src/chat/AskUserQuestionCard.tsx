import { Textarea } from '@ai-components/textarea-base'
import { useAtomValue, useStore } from '@einfach/react'
import {
  activeRunAtom,
  pendingQuestionAnswersAtom,
  setPendingQuestionAnswer,
} from '../agent/state/atoms'
import { continueAgentRunWithAnswers } from '../agent/runtime/loop'
import type { AskUserAnswerValue, AskUserQuestionItem } from '../agent/runtime/types'

export function AskUserQuestionCard() {
  const run = useAtomValue(activeRunAtom)
  const answers = useAtomValue(pendingQuestionAnswersAtom)
  const store = useStore()
  const payload = run?.pendingQuestion

  if (!payload || run.status !== 'waiting_user') return null

  const requiredQuestions = payload.questions.filter((question) => question.required)
  const answeredQuestions = payload.questions.filter((question) => hasQuestionAnswer(answers[question.id]))
  const answeredRequiredQuestions = requiredQuestions.filter((question) => hasQuestionAnswer(answers[question.id]))
  const canSubmit = requiredQuestions.every((question) => hasQuestionAnswer(answers[question.id]))

  return (
    <section
      className="question-card question-card--pause-confirmation question-card--waiting"
      aria-labelledby="ask-user-question-title"
    >
      <div className="question-card-header question-card-header--pause">
        <div className="timeline-event-top question-card-toolbar">
          <div className="question-card-title-block">
            <div className="question-card-eyebrow">运行已暂停</div>
            <h2 id="ask-user-question-title">{payload.title ?? '需要确认'}</h2>
          </div>
          <div
            className="question-card-status"
            aria-label={`已回答 ${answeredQuestions.length} / ${payload.questions.length} 个问题`}
          >
            <span className="status-pill status-waiting_user question-status-pill">等待确认</span>
            <span className="timeline-status question-progress">
              {answeredRequiredQuestions.length}/{requiredQuestions.length || payload.questions.length}
            </span>
          </div>
        </div>
      </div>
      <div className="question-card-body question-card-body--stack" aria-label="确认问题">
        {payload.questions.map((question, index) => (
          <QuestionInput
            key={question.id}
            question={question}
            index={index}
            value={answers[question.id]}
            onChange={(value) => setPendingQuestionAnswer(store, question.id, value)}
          />
        ))}
      </div>
      <div className="question-actions question-actions--footer">
        <span className="question-actions-hint">{canSubmit ? '确认后继续运行' : '请先完成必填项'}</span>
        <button
          type="button"
          className="primary-button question-submit-button"
          disabled={!canSubmit}
          onClick={() => continueAgentRunWithAnswers(store)}
        >
          继续
        </button>
      </div>
    </section>
  )
}

function QuestionInput({
  question,
  index,
  value,
  onChange,
}: {
  question: AskUserQuestionItem
  index: number
  value: AskUserAnswerValue | undefined
  onChange: (value: AskUserAnswerValue) => void
}) {
  const answered = hasQuestionAnswer(value)
  const answerStatusClassName = [
    'timeline-status',
    'question-answer-status',
    answered ? 'question-answer-status--answered' : 'question-answer-status--pending',
  ].join(' ')
  const questionClassName = [
    'question-item',
    `question-item--${question.type}`,
    question.required ? 'question-item--required' : 'question-item--optional',
    answered ? 'question-item--answered' : 'question-item--pending',
  ].join(' ')

  return (
    <div className={questionClassName} data-question-id={question.id}>
      <div className="question-label-row">
        <div className="question-label">
          <small className="question-index">{String(index + 1).padStart(2, '0')}</small> {question.text}
          {question.required && (
            <span className="question-required" aria-label="必填">
              *
            </span>
          )}
        </div>
        <span className={answerStatusClassName}>
          {answered ? '已回答' : question.required ? '必填' : '可选'}
        </span>
      </div>
      <div className={`question-control-shell question-control-shell--${question.type}`}>
        {renderQuestionControl(question, value, onChange)}
      </div>
    </div>
  )
}

function renderQuestionControl(
  question: AskUserQuestionItem,
  value: AskUserAnswerValue | undefined,
  onChange: (value: AskUserAnswerValue) => void,
) {
  if (question.type === 'text') {
    return (
      <Textarea
        value={typeof value === 'string' ? value : ''}
        autoSize={{ minRows: 1, maxRows: 4 }}
        placeholder="补充说明"
        onChange={onChange}
        className="question-textarea question-control question-control--text"
        aria-label={question.text}
      />
    )
  }

  if (question.type === 'confirm') {
    return (
      <div
        className="segmented-options question-options question-options--confirm"
        aria-label={question.text}
      >
        {[true, false].map((option) => (
          <button
            type="button"
            key={String(option)}
            className={
              value === option
                ? 'option-button question-option question-option--confirm selected question-option--selected'
                : 'option-button question-option question-option--confirm'
            }
            aria-pressed={value === option}
            onClick={() => onChange(option)}
          >
            {option ? '是' : '否'}
          </button>
        ))}
      </div>
    )
  }

  const options = question.options ?? []

  if (question.type === 'multi-choice') {
    const selected = Array.isArray(value) ? value : []
    return (
      <div
        className="segmented-options question-options question-options--multi-choice"
        aria-label={question.text}
      >
        {options.map((option) => (
          <button
            type="button"
            key={option}
            className={
              selected.includes(option)
                ? 'option-button question-option question-option--multi-choice selected question-option--selected'
                : 'option-button question-option question-option--multi-choice'
            }
            aria-pressed={selected.includes(option)}
            onClick={() => {
              onChange(
                selected.includes(option)
                  ? selected.filter((selectedOption) => selectedOption !== option)
                  : [...selected, option],
              )
            }}
          >
            {option}
          </button>
        ))}
      </div>
    )
  }

  return (
    <div
      className="segmented-options question-options question-options--single-choice"
      aria-label={question.text}
    >
      {options.map((option) => (
        <button
          type="button"
          key={option}
          className={
            value === option
              ? 'option-button question-option question-option--single-choice selected question-option--selected'
              : 'option-button question-option question-option--single-choice'
          }
          aria-pressed={value === option}
          onClick={() => onChange(option)}
        >
          {option}
        </button>
      ))}
    </div>
  )
}

function hasQuestionAnswer(answer: AskUserAnswerValue | undefined) {
  if (Array.isArray(answer)) return answer.length > 0
  return answer !== undefined && answer !== ''
}
