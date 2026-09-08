import { useLingui } from '@lingui/react/macro'
import type { SessionCapabilityCatalogItem, SessionCapabilityKind } from '@einfach-agent/core'

function matches(item: SessionCapabilityCatalogItem, query: string): boolean {
  const text = `${item.name} ${item.label} ${item.description}`.toLocaleLowerCase()
  return text.includes(query.trim().toLocaleLowerCase())
}

function unavailableDescriptionId(kind: SessionCapabilityKind, name: string): string {
  return `conversation-capability-unavailable-${kind}-${encodeURIComponent(name)}`
}

/** Renders one searchable kind of capability with its bulk and item selection controls. */
export function ConversationCapabilitySection({
  kind,
  items,
  query,
  readOnly,
  busy,
  onSetAll,
  onToggle,
}: {
  kind: SessionCapabilityKind
  items: SessionCapabilityCatalogItem[]
  query: string
  readOnly: boolean
  busy: boolean
  onSetAll: (items: SessionCapabilityCatalogItem[], selected: boolean) => void
  onToggle: (item: SessionCapabilityCatalogItem, selected: boolean) => void
}) {
  const { t } = useLingui()
  const visible = items.filter((item) => matches(item, query))
  const selected = items.filter((item) => item.selected).length
  const title = kind === 'tool' ? t`工具` : t`Skills`
  const selectable = visible.filter((item) => item.available)

  return (
    <section className="conversation-capability-section" aria-labelledby={`conversation-capability-${kind}`}>
      <header className="conversation-capability-section-heading">
        <div>
          <h3 id={`conversation-capability-${kind}`}>{title}</h3>
          <p>{t`已选 ${selected} / ${items.length}`}</p>
        </div>
        {!readOnly ? (
          <div className="conversation-capability-bulk-actions">
            <button type="button" disabled={busy || selectable.length === 0} onClick={() => onSetAll(selectable, true)}>
              {t`全选`}
            </button>
            <button type="button" disabled={busy || selectable.length === 0} onClick={() => onSetAll(selectable, false)}>
              {t`清空`}
            </button>
          </div>
        ) : null}
      </header>
      {items.length === 0 ? (
        <p className="conversation-capability-empty">{kind === 'tool'
          ? t`当前环境没有可配置的工具。`
          : t`当前环境没有可配置的 Skills。`}</p>
      ) : visible.length === 0 ? (
        <p className="conversation-capability-empty">{t`没有匹配的能力。`}</p>
      ) : (
        <ul className="conversation-capability-list">
          {visible.map((item) => (
            <li key={item.name} className={!item.available ? 'is-unavailable' : undefined}>
              <label>
                <input
                  type="checkbox"
                  checked={item.selected}
                  disabled={readOnly || busy || !item.available}
                  aria-label={t`切换 ${item.label}`}
                  aria-describedby={!item.available ? unavailableDescriptionId(kind, item.name) : undefined}
                  onChange={(event) => onToggle(item, event.target.checked)}
                />
                <span className="conversation-capability-copy">
                  <strong>{item.label}</strong>
                  {!item.available ? (
                    <small id={unavailableDescriptionId(kind, item.name)}>
                      {t`此能力在当前环境中已不可用。`}
                    </small>
                  ) : item.description ? <small>{item.description}</small> : null}
                </span>
              </label>
              {!item.available ? (
                <span className="conversation-capability-unavailable">
                  {t`不可用`}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
