import { useEffect, useRef, useState } from 'react'
import type { SessionPage, SessionPageHost } from '@einfach-agent/browser-agent'

export function PagePicker({ host, page, onChange, initialPageId, disabled }: { host: SessionPageHost; page?: SessionPage; onChange(page: SessionPage | undefined): void; initialPageId?: string; disabled?: boolean }) {
  const [choices, setChoices] = useState<readonly SessionPage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const request = useRef(0)
  const selected = useRef(page)
  selected.current = page
  async function refresh() {
    const version = ++request.current
    const priorId = selected.current?.id ?? initialPageId
    onChange(undefined)
    setLoading(true); setError('')
    try {
      const next = await host.listPages()
      if (version !== request.current) return
      setChoices(next)
      onChange(next.find((item) => item.id === priorId) ?? next.find((item) => item.active))
    } catch (value) {
      if (version === request.current) { setError(value instanceof Error ? value.message : '读取页面列表失败。'); onChange(undefined) }
    } finally { if (version === request.current) setLoading(false) }
  }
  useEffect(() => { void refresh(); return () => { request.current++ } }, [host])
  return <div className="bav-page-picker">
    <label>目标页面<select aria-label="目标页面" value={page?.id ?? ''} disabled={disabled || loading} onChange={(event) => onChange(choices.find((item) => item.id === event.target.value))}>
      <option value="">{loading ? '读取页面列表…' : '选择要操作的页面'}</option>
      {choices.map((item) => <option key={item.id} value={item.id}>{item.active ? '当前 · ' : ''}{item.title}{item.url ? ` · ${siteName(item.url)}` : ''}{item.detail ? ` · ${item.detail}` : ''}</option>)}
    </select></label>
    {page && <div className="bav-page-preview"><strong>{page.title}</strong><span>{page.url || '浏览器未提供页面信息'}</span><small>{page.detail}</small></div>}
    {(error || page?.unavailableReason) && <p role="alert" className="bav-error">{error || page?.unavailableReason}</p>}
    {!loading && !choices.length && <p>没有可选页面，请先打开目标网页。</p>}
    <button type="button" className="bav-secondary" disabled={disabled || loading} onClick={() => void refresh()}>{loading ? '读取中…' : '刷新页面列表'}</button>
  </div>
}

function siteName(url: string): string { try { return new URL(url).host } catch { return url } }
