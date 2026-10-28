declare namespace chrome {
  namespace runtime {
    interface MessageSender { id?: string; url?: string; tab?: { id?: number }; frameId?: number; documentId?: string }
    const id: string
    const lastError: { message?: string } | undefined
    const onMessage: { addListener(listener: (message: unknown, sender: MessageSender, sendResponse: (response: unknown) => void) => boolean | void): void }
    function sendMessage(message: unknown): Promise<unknown>
    function getURL(path: string): string
    const onInstalled: { addListener(listener: () => void): void }
    const onStartup: { addListener(listener: () => void): void }
  }
  namespace tabs {
    interface Tab { id?: number; url?: string; title?: string; windowId?: number; active?: boolean; index?: number; status?: string; pendingUrl?: string }
    function query(query: { active?: boolean; currentWindow?: boolean; lastFocusedWindow?: boolean }): Promise<Tab[]>
    function get(tabId: number): Promise<Tab>
    function update(tabId: number, options: { active?: boolean }): Promise<Tab>
    const onUpdated: { addListener(listener: (tabId: number, change: { status?: string; url?: string }, tab: Tab) => void): void; removeListener(listener: (tabId: number, change: { status?: string; url?: string }, tab: Tab) => void): void }
    const onRemoved: { addListener(listener: (tabId: number) => void): void; removeListener(listener: (tabId: number) => void): void }
    function create(options: { url: string; active?: boolean }): Promise<Tab>
    function remove(tabId: number): Promise<void>
    function sendMessage(tabId: number, message: unknown, options?: { frameId?: number; documentId?: string }): Promise<unknown>
  }
  namespace action { const onClicked: { addListener(listener: (tab: tabs.Tab) => void): void } }
  namespace permissions {
    function contains(permissions: { origins: string[] }): Promise<boolean>
    function request(permissions: { origins: string[] }): Promise<boolean>
    function getAll(): Promise<{ origins?: string[] }>
    const onAdded: { addListener(listener: () => void): void }
    const onRemoved: { addListener(listener: (permissions: { origins?: string[] }) => void): void }
    const addHostAccessRequest: undefined | ((request: { tabId: number }) => Promise<void>)
  }
  namespace storage { namespace local { function get(key: string): Promise<Record<string, unknown>>; function set(items: Record<string, unknown>): Promise<void> } }
  namespace scripting {
    type ExecutionWorld = 'ISOLATED' | 'MAIN'
    interface InjectionResult<T = unknown> { documentId?: string; frameId: number; result?: T; error?: string }
    interface ScriptInjection<Args extends readonly unknown[] = readonly unknown[], Result = unknown> {
      target: { tabId: number; frameIds?: number[]; documentIds?: string[] }
      world?: ExecutionWorld
      files?: string[]
      func?: (...args: Args) => Result
      args?: Args
    }
    interface RegisteredContentScript { id: string; matches: string[]; js: string[]; runAt?: 'document_start' | 'document_end' | 'document_idle'; allFrames?: boolean; persistAcrossSessions?: boolean; world?: ExecutionWorld }
    function executeScript<Args extends readonly unknown[], Result>(details: ScriptInjection<Args, Result>): Promise<InjectionResult<Awaited<Result>>[]>
    function registerContentScripts(scripts: RegisteredContentScript[]): Promise<void>
    function unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>
    function getRegisteredContentScripts(filter?: { ids?: string[] }): Promise<RegisteredContentScript[]>
  }
  namespace windows { function update(windowId: number, options: { focused: boolean }): Promise<unknown> }
  namespace sidePanel {
    function setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>
    function open(options: { windowId: number }): Promise<void>
  }
}
