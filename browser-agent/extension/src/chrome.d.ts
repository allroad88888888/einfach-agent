declare namespace chrome {
  namespace runtime {
    interface MessageSender { id?: string; url?: string; tab?: { id?: number }; frameId?: number; documentId?: string }
    const id: string
    const lastError: { message?: string } | undefined
    const onMessage: { addListener(listener: (message: unknown, sender: MessageSender, sendResponse: (response: unknown) => void) => boolean | void): void }
    function sendMessage(message: unknown): Promise<unknown>
    function getURL(path: string): string
  }
  namespace tabs {
    interface Tab { id?: number; url?: string; title?: string }
    function query(query: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>
    function create(options: { url: string; active?: boolean }): Promise<Tab>
    function remove(tabId: number): Promise<void>
    function sendMessage(tabId: number, message: unknown, options?: { frameId?: number; documentId?: string }): Promise<unknown>
  }
  namespace permissions {
    function contains(permissions: { origins: string[] }): Promise<boolean>
    function request(permissions: { origins: string[] }): Promise<boolean>
  }
  namespace storage { namespace local { function get(key: string): Promise<Record<string, unknown>>; function set(items: Record<string, unknown>): Promise<void> } }
  namespace scripting { function executeScript(details: { target: { tabId: number; frameIds?: number[] }; files: string[] }): Promise<unknown> }
  namespace sidePanel { function setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void> }
}
