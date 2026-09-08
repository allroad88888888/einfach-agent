import { forwardRef, useEffect, useState } from 'react'
import { useLingui } from '@lingui/react/macro'
import {
  getSessionCapabilityCatalog,
  type SessionCapabilityCatalog,
} from '@einfach-agent/core'
import './conversation-capabilities.css'

function selectedCount(items: SessionCapabilityCatalog['tools']): number {
  return items.filter((item) => item.selected).length
}

/** Opens the conversation capability editor and summarizes the current selection. */
export const ConversationCapabilitiesButton = forwardRef<HTMLButtonElement, {
  sessionId: string
  policyVersion: string
  open: boolean
  onOpen: () => void
}>(function ConversationCapabilitiesButton({ sessionId, policyVersion, open, onOpen }, ref) {
  const { t } = useLingui()
  const [catalog, setCatalog] = useState<SessionCapabilityCatalog>()

  useEffect(() => {
    let current = true
    void getSessionCapabilityCatalog(sessionId).then(
      (next) => { if (current) setCatalog(next) },
      () => { if (current) setCatalog(undefined) },
    )
    return () => { current = false }
  }, [policyVersion, sessionId])

  const tools = catalog ? selectedCount(catalog.tools) : 0
  const skills = catalog ? selectedCount(catalog.skills) : 0
  const summary = catalog
    ? t`${tools} 个工具 · ${skills} 个 Skills`
    : t`加载能力…`
  const label = t`会话能力：${summary}`

  return (
    <button
      ref={ref}
      type="button"
      className="conversation-capabilities-button"
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={label}
      onClick={onOpen}
    >
      <CapabilityGlyph />
    </button>
  )
})

function CapabilityGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2 4h3m3 0h6M2 8h7m3 0h2M2 12h2m3 0h7" />
      <circle cx="6.5" cy="4" r="1.25" />
      <circle cx="10.5" cy="8" r="1.25" />
      <circle cx="5.5" cy="12" r="1.25" />
    </svg>
  )
}
