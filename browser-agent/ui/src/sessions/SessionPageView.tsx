import { useRef, useState } from 'react'
import type { SessionPage, SessionPageContext, SessionPageHost } from '@einfach-agent/browser-agent'
import { PagePicker } from './PagePicker'

export function SessionPageView({ host, sessionId, context }: { host: SessionPageHost; sessionId: string; context?: SessionPageContext }) {
  const [editing, setEditing] = useState(false)
  const [page, setPage] = useState<SessionPage>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const details = useRef<HTMLDetailsElement>(null)
  async function bind() {
    if (!page || page.unavailableReason || busy) return
    setBusy(true); setError('')
    try { await host.bindSession(sessionId, page); setEditing(false); if (details.current) details.current.open = false }
    catch (value) { setError(value instanceof Error ? value.message : '绑定失败，请重试。') }
    finally { setBusy(false) }
  }
  async function reveal() {
    try { await host.revealPage(sessionId); setError('') }
    catch (value) { setError(value instanceof Error ? value.message : '无法定位页面。') }
  }
  const state = context?.status ?? 'unbound'
  return <details ref={details} className={`bav-session-page ${state}`} onKeyDown={(event) => {
    if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); setEditing(false); if (details.current) { details.current.open = false; details.current.querySelector('summary')?.focus() } }
  }}>
    <summary aria-label="目标页面详情"><span className="bav-page-indicator" /><span>{context?.page.title ?? '未绑定页面'}</span><small>{state === 'ready' ? domain(context!.page.url) : ({ connecting: '连接中', changed: '页面已变化', closed: '页面已关闭', unavailable: '连接失效', unbound: '选择页面' })[state]}</small></summary>
    <div className="bav-page-details">
      {context && <p className="bav-page-url">{context.page.url}</p>}
      {context?.message && <p role="status">{context.message}</p>}
      {editing ? <>
        <PagePicker host={host} initialPageId={context?.page.id} page={page} onChange={setPage} disabled={busy} />
        <div className="bav-form-actions"><button type="button" disabled={busy || !page || Boolean(page.unavailableReason)} onClick={() => void bind()}>{busy ? '连接中…' : '确认绑定'}</button><button type="button" className="bav-secondary" disabled={busy} onClick={() => setEditing(false)}>取消</button></div>
      </> : <div className="bav-form-actions">
        <button type="button" className="bav-secondary" disabled={!context || state === 'closed'} onClick={() => void reveal()}>定位标签页</button>
        <button type="button" className="bav-secondary" onClick={() => { setError(''); setEditing(true) }}>{state === 'ready' ? '更换页面' : '重新绑定页面'}</button>
      </div>}
      {error && <p role="alert" className="bav-error">{error}</p>}
    </div>
  </details>
}
function domain(url: string): string { try { return new URL(url).host } catch { return url } }
