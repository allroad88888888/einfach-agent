import { Markdown } from '@ai-components/markdown'
import { useAtomValue, useStore } from '@einfach/react'
import { isBusyAtom, type BrowserCard } from '../agent/state/atoms'
import { startAgentRun } from '../agent/runtime/loop'

// BG5: bound the context folded into the option prompt so a card with a huge
// body / many items can never blow up the outgoing message. Body is clipped to
// 200 chars; items/options keep at most the first 10 entries and are each
// jointly clipped to 300 chars.
const BODY_LIMIT = 200
const LIST_HEAD = 10
const LIST_LIMIT = 300

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

function summarizeList(list: string[]): string {
  const head = list.slice(0, LIST_HEAD)
  const joined = head.join('、') + (list.length > LIST_HEAD ? ` 等${list.length}项` : '')
  return clip(joined, LIST_LIMIT)
}

// BF6: the card is NOT in conversation history, so when an option is clicked the
// new run's prompt must carry enough context for the model — not just a generic
// title. We fold in the body (clipped) and the items/options summaries alongside
// the chosen option (each bounded per BG5).
function buildOptionPrompt(card: BrowserCard, option: string): string {
  const parts = [`用户选择了卡片「${card.title}」中的选项:「${option}」。`]
  if (card.body && card.body.trim()) {
    parts.push(`卡片正文:${clip(card.body.trim(), BODY_LIMIT)}`)
  }
  if (card.items && card.items.length) {
    parts.push(`卡片条目:${summarizeList(card.items)}`)
  }
  if (card.options && card.options.length) {
    parts.push(`全部可选项:${summarizeList(card.options)}`)
  }
  return parts.join('\n')
}

// browser_action render_card: a single info card rendered inline in the
// conversation transcript (D4). Body is markdown; options are buttons that, when
// clicked, start a NEW run with structured natural-language text (D5) — the card
// is not in conversation history, so the model needs the title + option spelled
// out. Options are disabled while a run is busy (no silent abort).
export function BrowserActionCard({ card }: { card: BrowserCard }) {
  const store = useStore()
  const busy = useAtomValue(isBusyAtom)

  return (
    <article className="browser-card agent-browser-card" aria-label={`信息卡片：${card.title}`}>
      <div className="browser-card-title agent-browser-card-title">{card.title}</div>
      {card.body && (
        <div className="browser-card-body agent-browser-card-body">
          <Markdown className="browser-card-markdown">{card.body}</Markdown>
        </div>
      )}
      {card.items && card.items.length > 0 && (
        <ul className="browser-card-items agent-browser-card-items">
          {card.items.map((item, index) => (
            <li key={index} className="browser-card-item">
              {item}
            </li>
          ))}
        </ul>
      )}
      {card.options && card.options.length > 0 && (
        <div className="browser-card-options agent-browser-card-options">
          {card.options.map((option, index) => (
            <button
              key={index}
              type="button"
              className="secondary-button browser-card-option agent-browser-card-option"
              disabled={busy}
              onClick={() => {
                startAgentRun(store, buildOptionPrompt(card, option))
              }}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </article>
  )
}
