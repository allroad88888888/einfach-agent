import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useLingui } from '@lingui/react/macro'
import {
  cloneSessionCapabilities,
  getSessionCapabilityCatalog,
  toggleDraftSessionCapability,
  type SessionCapabilityCatalog,
  type SessionCapabilityCatalogItem,
} from '@einfach-agent/core'
import { ConversationCapabilitySection } from './ConversationCapabilitySection'
import './conversation-capabilities.css'

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Hosts the capability editor, including loading, command execution, and read-only states. */
export function ConversationCapabilitiesPanel({
  open,
  sessionId,
  policyVersion,
  policyState,
  triggerRef,
  onClose,
}: {
  open: boolean
  sessionId: string
  policyVersion: string
  policyState?: SessionCapabilityCatalog['state']
  triggerRef: RefObject<HTMLButtonElement | null>
  onClose: () => void
}) {
  const { t } = useLingui()
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)
  const loadGeneration = useRef(0)
  const inputsRef = useRef({ open, policyVersion, sessionId })
  inputsRef.current = { open, policyVersion, sessionId }
  const [catalog, setCatalog] = useState<SessionCapabilityCatalog>()
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const load = useCallback(async (preserveError = false) => {
    const inputs = inputsRef.current
    if (!inputs.open || inputs.sessionId !== sessionId || inputs.policyVersion !== policyVersion) return
    const generation = ++loadGeneration.current
    const isCurrent = () => {
      const currentInputs = inputsRef.current
      return generation === loadGeneration.current
        && currentInputs.open
        && currentInputs.sessionId === sessionId
        && currentInputs.policyVersion === policyVersion
    }
    if (!isCurrent()) return
    setLoading(true)
    if (!preserveError) setError(undefined)
    try {
      const next = await getSessionCapabilityCatalog(sessionId)
      if (isCurrent()) setCatalog(next)
    } catch (reason) {
      if (isCurrent()) {
        setCatalog(undefined)
        setError(errorText(reason))
      }
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [policyVersion, sessionId])

  useEffect(() => {
    if (!open) {
      loadGeneration.current += 1
      return
    }
    setCatalog(undefined)
    void load()
    return () => { loadGeneration.current += 1 }
  }, [load, open])

  useEffect(() => {
    if (open) {
      wasOpen.current = true
      queueMicrotask(() => closeRef.current?.focus())
    } else if (wasOpen.current) {
      wasOpen.current = false
      triggerRef.current?.focus()
    }
  }, [open, triggerRef])

  const update = async (items: SessionCapabilityCatalogItem[], selected: boolean) => {
    if (!catalog || catalog.state !== 'draft' || items.length === 0) return
    setBusy(true)
    setError(undefined)
    try {
      for (const item of items) {
        await toggleDraftSessionCapability(item.kind, item.name, selected, sessionId)
      }
      await load()
    } catch (reason) {
      setError(errorText(reason))
      await load(true)
    } finally {
      setBusy(false)
    }
  }

  const clone = async () => {
    setBusy(true)
    setError(undefined)
    try {
      await cloneSessionCapabilities(sessionId)
      onClose()
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null
  const effectiveState = policyState ?? catalog?.state
  const readOnly = effectiveState !== 'draft'
  const statusDescription = effectiveState === 'draft'
    ? t`首次发送前可编辑此对话的能力。`
    : effectiveState === 'locked'
      ? t`配置在发送首条消息后锁定。`
      : t`旧版默认配置。此会话使用未受限的历史默认值。`
  const focusable = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])

  return createPortal(
    <div
      className="conversation-capabilities-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <section
        ref={dialogRef}
        className="conversation-capabilities-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="conversation-capabilities-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onClose()
            return
          }
          if (event.key !== 'Tab') return
          const elements = focusable()
          const first = elements[0]
          const last = elements.at(-1)
          if (!first || !last) return
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }}
      >
        <header className="conversation-capabilities-header">
          <div>
            <p>{t`会话设置`}</p>
            <h2 id="conversation-capabilities-title">{t`能力`}</h2>
          </div>
          <button ref={closeRef} type="button" className="conversation-capabilities-close" aria-label={t`关闭能力设置`} onClick={onClose}>×</button>
        </header>
        {loading && !catalog ? <div className="conversation-capabilities-loading" role="status"><span />{t`正在加载能力…`}</div> : null}
        {error ? (
          <div className="conversation-capabilities-error" role="alert">
            <span>{t`无法加载或更新能力设置。`}</span>
            <button type="button" onClick={() => void load()}>{t`重试`}</button>
          </div>
        ) : null}
        {catalog ? (
          <>
            <p className={`conversation-capabilities-state is-${effectiveState}`}>
              {statusDescription}
            </p>
            <label className="conversation-capabilities-search">
              <span>{t`搜索工具和 Skills`}</span>
              <input value={query} disabled={loading || busy} placeholder={t`按名称或描述搜索`} onChange={(event) => setQuery(event.target.value)} />
            </label>
            <div className="conversation-capabilities-body" aria-busy={loading || busy}>
              <ConversationCapabilitySection kind="tool" items={catalog.tools} query={query} readOnly={readOnly} busy={loading || busy} onSetAll={update} onToggle={(item, selected) => void update([item], selected)} />
              <ConversationCapabilitySection kind="skill" items={catalog.skills} query={query} readOnly={readOnly} busy={loading || busy} onSetAll={update} onToggle={(item, selected) => void update([item], selected)} />
            </div>
            {readOnly ? (
              <footer className="conversation-capabilities-footer">
                <button type="button" className="conversation-capabilities-clone" disabled={busy || loading} onClick={() => void clone()}>
                  {effectiveState === 'legacy-unrestricted' ? t`按当前安全默认新建对话` : t`按此配置新建对话`}
                </button>
              </footer>
            ) : null}
          </>
        ) : null}
      </section>
    </div>,
    document.body,
  )
}
