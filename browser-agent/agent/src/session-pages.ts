/** Optional page integration supplied by the embedding host; no browser or UI dependency. */
export interface SessionPage {
  id: string
  title: string
  url: string
  detail?: string
  active?: boolean
  unavailableReason?: string
}
export interface SessionPageContext {
  page: SessionPage
  status: 'ready' | 'connecting' | 'changed' | 'closed' | 'unavailable'
  message?: string
}
export interface SessionPageHost {
  listPages(): Promise<readonly SessionPage[]>
  createSession(agentId: string, options: { title?: string; page: SessionPage }): Promise<string>
  getSessionPage(sessionId: string): SessionPageContext | undefined
  subscribe(listener: () => void): () => void
  bindSession(sessionId: string, page: SessionPage): Promise<void>
  revealPage(sessionId: string): Promise<void>
}
