import type { SessionPageContext } from '@einfach-agent/browser-agent'
import { CHANNEL, isTarget, type ExtensionResponse, type TargetBinding } from './protocol'

const STORAGE_KEY = 'einfach-browser-agent-bindings-v1'
type Binding = { target: TargetBinding; status: SessionPageContext['status']; message?: string; requiresRebind?: boolean }

/** Keeps the last chosen page even when its live document is unavailable. */
export class PageBindings {
  private readonly bindings = new Map<string, Binding>()
  private readonly listeners = new Set<() => void>()
  private writes: Promise<void> = Promise.resolve()
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private emit(): void { for (const listener of this.listeners) listener() }
  target(sessionId: string): TargetBinding | undefined {
    const entry = this.bindings.get(sessionId)
    return entry?.status === 'ready' ? entry.target : undefined
  }
  context(sessionId: string): SessionPageContext | undefined {
    const entry = this.bindings.get(sessionId)
    if (!entry) return undefined
    return { page: { id: String(entry.target.tabId), title: entry.target.title, url: entry.target.url }, status: entry.status, message: entry.message }
  }
  async bind(sessionId: string, target: TargetBinding): Promise<void> {
    const previous = this.bindings.get(sessionId)
    const next: Binding = { target: { ...target }, status: 'ready' }
    this.bindings.set(sessionId, next); this.emit()
    try { await this.persist() }
    catch (error) {
      if (this.bindings.get(sessionId) === next) {
        if (previous) this.bindings.set(sessionId, previous)
        else this.bindings.delete(sessionId)
        this.emit()
      }
      throw error
    }
  }
  async unbind(sessionId: string): Promise<void> { this.bindings.delete(sessionId); this.emit(); await this.persist() }
  invalidate(sessionId: string, status: Binding['status'], message: string): void {
    const entry = this.bindings.get(sessionId)
    if (!entry) return
    const requiresRebind = entry.requiresRebind || status === 'changed' || status === 'closed'
    this.bindings.set(sessionId, { ...entry, status, message, requiresRebind }); this.emit()
    if (requiresRebind && !entry.requiresRebind) void this.persist().catch(() => {})
  }
  async restore(sessionIds: readonly string[]): Promise<void> {
    const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return
    for (const id of sessionIds) {
      const target = (stored as Record<string, unknown>)[id]
      if (isTarget(target)) this.bindings.set(id, { target, status: 'connecting', requiresRebind: 'requiresRebind' in target && target.requiresRebind === true })
    }
    await Promise.all([...this.bindings.keys()].map((id) => this.check(id)))
    await this.persist()
  }
  private async check(sessionId: string, allowRefresh = false): Promise<void> {
    const entry = this.bindings.get(sessionId)
    if (!entry) return
    const current = () => this.bindings.get(sessionId) === entry
    let tab: chrome.tabs.Tab
    try { tab = await chrome.tabs.get(entry.target.tabId) }
    catch { if (current()) this.invalidate(sessionId, 'closed', '页面已关闭，请选择页面重新绑定。'); return }
    if (!current()) return
    if (!tab.url) { this.invalidate(sessionId, 'unavailable', '无法访问原页面，请在目标页点击插件图标后重新绑定。'); return }
    if (tab.url !== entry.target.url || (tab.pendingUrl && tab.pendingUrl !== entry.target.url)) {
      this.invalidate(sessionId, 'changed', '页面地址已变化，请确认目标页面后重新绑定。'); return
    }
    if (entry.requiresRebind) { this.invalidate(sessionId, 'changed', '原页面曾发生变化，请确认后重新绑定。'); return }
    if (tab.status === 'loading') { this.invalidate(sessionId, 'connecting', '页面正在加载，完成后重新连接。'); return }
    try {
      const response = await chrome.runtime.sendMessage({ channel: CHANNEL, kind: 'handshake', tabId: entry.target.tabId, frameId: entry.target.frameId }) as ExtensionResponse
      if (!current()) return
      if (!response?.ok || !isTarget(response.data)) throw new Error('invalid handshake')
      const next = response.data
      if (next.tabId !== entry.target.tabId || next.frameId !== entry.target.frameId || next.url !== entry.target.url) {
        this.invalidate(sessionId, 'changed', '页面已变化，请重新绑定。'); return
      }
      if (next.documentId !== entry.target.documentId && !allowRefresh) {
        this.invalidate(sessionId, 'changed', '页面已重新加载，请重新绑定。'); return
      }
      await this.bind(sessionId, next)
    } catch { if (current()) this.invalidate(sessionId, 'unavailable', '页面连接失败，请重新绑定。') }
  }
  watch(): () => void {
    const updated = (tabId: number, change: { status?: string; url?: string }, tab: chrome.tabs.Tab) => {
      for (const [id, entry] of this.bindings) {
        if (entry.target.tabId !== tabId) continue
        if ((change.url && change.url !== entry.target.url) || (tab.pendingUrl && tab.pendingUrl !== entry.target.url)) {
          this.invalidate(id, 'changed', '页面地址已变化，请确认后重新绑定。')
        } else if (change.status === 'loading') {
          // A changed/closed target always needs an explicit choice, even if it later returns to the same URL.
          if (entry.status === 'ready') this.invalidate(id, 'connecting', '页面正在加载，完成后重新连接。')
        } else if (change.status === 'complete' && entry.status !== 'changed' && entry.status !== 'closed') {
          void this.check(id, true)
        }
      }
    }
    const removed = (tabId: number) => {
      for (const [id, entry] of this.bindings) if (entry.target.tabId === tabId) this.invalidate(id, 'closed', '页面已关闭，请选择页面重新绑定。')
    }
    chrome.tabs.onUpdated.addListener(updated); chrome.tabs.onRemoved.addListener(removed)
    return () => { chrome.tabs.onUpdated.removeListener(updated); chrome.tabs.onRemoved.removeListener(removed) }
  }
  private persist(): Promise<void> {
    const snapshot = Object.fromEntries([...this.bindings].map(([id, entry]) => [id, { ...entry.target, requiresRebind: entry.requiresRebind ?? false }]))
    const write = this.writes.then(() => chrome.storage.local.set({ [STORAGE_KEY]: snapshot }))
    this.writes = write.catch(() => {})
    return write
  }
}
