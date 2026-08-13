// P8-d AskUserQuestionCard：run 暂停等待用户补充时渲染的「确认问题」卡片。
// ---------------------------------------------------------------------------
// 当前 UI/runtime 契约：
//   · U1 runtime/UI 隔离：本组件只做两件事 —— 读 atom（runAtom /
//     pendingQuestionAnswersAtom）+ 调命令（answerQuestion / resumeWithAnswers）。
//     绝不直接 setter atom、不 import writers、不碰 store 实例。
//   · U3 挂在「当前会话 store」的 Provider 下，读到的都是该会话的 run / 答案。
// pendingQuestion 是 unknown（模型 tool_call 原样 args），渲染前先经 normalize
// 防御式收敛（§5 R1，绝不抛）。移植自旧 src/chat/AskUserQuestionCard.tsx，但换掉
// @ai-components 控件（text 用原生 textarea）与 store 参数（改调命令）。

import { useAtomValue } from '@einfach/react'
import {
  runAtom,
  pendingQuestionAnswersAtom,
  type AskUserAnswerValue,
  normalizeAskUserQuestionPayload,
  type AskUserQuestionItem,
  answerQuestion,
  resumeWithAnswers,
} from '@web-agent/core'

export function AskUserQuestionCard({ surface = 'conversation' }: { surface?: 'conversation' | 'plan' }) {
  const run = useAtomValue(runAtom)
  const answers = useAtomValue(pendingQuestionAnswersAtom)

  // 仅当当前会话 run 停在 waiting_user 且挂着 pendingQuestion 才渲染，否则不占位。
  if (run?.status !== 'waiting_user' || !run.pendingQuestion) return null
  const decisionSurface = run.pendingUserDecision?.origin.surface ?? 'conversation'
  if (decisionSurface !== surface) return null

  // 防御式规整 unknown payload → { title?, questions }（非法项已被丢弃）。
  const payload = normalizeAskUserQuestionPayload(run.pendingUserDecision?.payload ?? run.pendingQuestion)

  // 必填题全部答齐才允许「继续」；无必填题时恒可继续。
  const requiredQuestions = payload.questions.filter((question) => question.required)
  const canSubmit = requiredQuestions.every((question) => hasQuestionAnswer(answers[question.id]))

  return (
    <section className={`agentnew-ask ${surface === 'plan' ? 'is-plan-embedded' : ''}`} aria-labelledby="agentnew-ask-title">
      <header className="agentnew-ask-header">
        <span className="agentnew-ask-eyebrow">{surface === 'plan' ? '计划等待决策' : '运行已暂停'}</span>
        <h2 id="agentnew-ask-title" className="agentnew-ask-title">
          {payload.title ?? '需要确认'}
        </h2>
      </header>

      <div className="agentnew-ask-body" aria-label="确认问题">
        {payload.questions.map((question, index) => (
          <QuestionInput
            key={question.id}
            question={question}
            index={index}
            value={answers[question.id]}
            onChange={(value) => answerQuestion(question.id, value)}
          />
        ))}
      </div>

      <footer className="agentnew-ask-footer">
        <span className="agentnew-ask-hint">{canSubmit ? '确认后继续运行' : '请先完成必填项'}</span>
        <button
          type="button"
          className="agentnew-ask-submit"
          disabled={!canSubmit}
          onClick={() => resumeWithAnswers()}
        >
          继续
        </button>
      </footer>
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
  const itemClassName = [
    'agentnew-ask-item',
    `agentnew-ask-item--${question.type}`,
    question.required ? 'agentnew-ask-item--required' : 'agentnew-ask-item--optional',
    answered ? 'agentnew-ask-item--answered' : 'agentnew-ask-item--pending',
  ].join(' ')

  return (
    <div className={itemClassName} data-question-id={question.id}>
      <div className="agentnew-ask-label">
        <span className="agentnew-ask-index">{String(index + 1).padStart(2, '0')}</span>
        <span className="agentnew-ask-text">{question.text}</span>
        {question.required && (
          <span className="agentnew-ask-required" aria-label="必填">
            *
          </span>
        )}
      </div>
      <div className={`agentnew-ask-control agentnew-ask-control--${question.type}`}>
        {renderQuestionControl(question, value, onChange)}
      </div>
    </div>
  )
}

// 按 type 渲染控件。text=原生 textarea；confirm=是/否；single/multi-choice=选项按钮。
function renderQuestionControl(
  question: AskUserQuestionItem,
  value: AskUserAnswerValue | undefined,
  onChange: (value: AskUserAnswerValue) => void,
) {
  if (question.type === 'text') {
    return (
      <textarea
        className="agentnew-ask-textarea"
        aria-label={question.text}
        placeholder="补充说明"
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
      />
    )
  }

  if (question.type === 'confirm') {
    return (
      <div className="agentnew-ask-options agentnew-ask-options--confirm" aria-label={question.text}>
        {[true, false].map((option) => (
          <button
            type="button"
            key={String(option)}
            className={optionClassName('confirm', value === option)}
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
        className="agentnew-ask-options agentnew-ask-options--multi-choice"
        aria-label={question.text}
      >
        {options.map((option) => {
          const isSelected = selected.includes(option)
          return (
            <button
              type="button"
              key={option}
              className={optionClassName('multi-choice', isSelected)}
              aria-pressed={isSelected}
              onClick={() =>
                onChange(
                  isSelected
                    ? selected.filter((entry) => entry !== option)
                    : [...selected, option],
                )
              }
            >
              {option}
            </button>
          )
        })}
      </div>
    )
  }

  // single-choice：单选，点谁传谁（string）。
  return (
    <div
      className="agentnew-ask-options agentnew-ask-options--single-choice"
      aria-label={question.text}
    >
      {options.map((option) => (
        <button
          type="button"
          key={option}
          className={optionClassName('single-choice', value === option)}
          aria-pressed={value === option}
          onClick={() => onChange(option)}
        >
          {option}
        </button>
      ))}
    </div>
  )
}

// 选项按钮 className（选中态追加 --selected）。
function optionClassName(type: AskUserQuestionItem['type'], selected: boolean): string {
  const base = `agentnew-ask-option agentnew-ask-option--${type}`
  return selected ? `${base} agentnew-ask-option--selected` : base
}

// 是否已作答：数组非空 / 非 undefined 非空串 / boolean（含 false）均算已答。
function hasQuestionAnswer(answer: AskUserAnswerValue | undefined): boolean {
  if (Array.isArray(answer)) return answer.length > 0
  if (typeof answer === 'boolean') return true
  return answer !== undefined && answer !== ''
}
