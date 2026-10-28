const SCRIPT_IDS = ['einfach-page-isolated', 'einfach-network-main'] as const
// Service access is for extension fetch only, never for page/network recorder injection.
const SERVICE_ORIGINS = new Set(['https://paddleocr.aistudio-app.com/*', 'https://paddleocr-store-1.bj.bcebos.com/*'])
let registration = Promise.resolve()
let registeredSignature: string | undefined

export function syncRegisteredScripts(): Promise<void> {
  const attempt = registration.then(async () => {
    const origins = (await chrome.permissions.getAll()).origins?.filter(isAllowedPattern) ?? []
    const desired = scriptsFor(origins)
    const signature = JSON.stringify([...origins].sort())
    if (registeredSignature !== signature) {
      const current = await chrome.scripting.getRegisteredContentScripts({ ids: [...SCRIPT_IDS] })
      if (!sameScripts(current, desired)) {
        await chrome.scripting.unregisterContentScripts({ ids: [...SCRIPT_IDS] }).catch(() => undefined)
        if (desired.length > 0) await chrome.scripting.registerContentScripts(desired)
      }
      registeredSignature = signature
    }
    await injectOpenTabs(origins)
  })
  registration = attempt.catch(() => undefined)
  return attempt
}

async function injectOpenTabs(origins: readonly string[]): Promise<void> {
  if (origins.length === 0) return
  const tabs = await chrome.tabs.query({})
  await Promise.all(tabs.map(async (tab) => {
    if (!tab.id || !tab.url || !origins.some((pattern) => matches(pattern, tab.url!))) return
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'ISOLATED', files: ['content-script.js'] })
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'MAIN', files: ['network-main.js'] })
    } catch { /* One restricted, closed, or navigating tab must not block other tabs. */ }
  }))
}

function scriptsFor(origins: readonly string[]): chrome.scripting.RegisteredContentScript[] {
  if (origins.length === 0) return []
  return [
    { id: SCRIPT_IDS[0], matches: [...origins], js: ['content-script.js'], runAt: 'document_start', allFrames: false, persistAcrossSessions: true, world: 'ISOLATED' },
    { id: SCRIPT_IDS[1], matches: [...origins], js: ['network-main.js'], runAt: 'document_start', allFrames: false, persistAcrossSessions: true, world: 'MAIN' },
  ]
}

function sameScripts(current: readonly chrome.scripting.RegisteredContentScript[], desired: readonly chrome.scripting.RegisteredContentScript[]): boolean {
  const normalize = (scripts: readonly chrome.scripting.RegisteredContentScript[]) => scripts.map((script) => ({
    id: script.id,
    matches: [...script.matches].sort(),
    js: [...script.js],
    runAt: script.runAt ?? 'document_idle',
    allFrames: script.allFrames ?? false,
    persistAcrossSessions: script.persistAcrossSessions ?? true,
    world: script.world ?? 'ISOLATED',
  })).sort((left, right) => left.id.localeCompare(right.id))
  return JSON.stringify(normalize(current)) === JSON.stringify(normalize(desired))
}

export async function disposeRemovedOrigins(origins: readonly string[]): Promise<void> {
  if (origins.length === 0) return
  const tabs = await chrome.tabs.query({})
  await Promise.all(tabs.filter((tab) => tab.id && tab.url && origins.some((pattern) => matches(pattern, tab.url!))).map(async (tab) => {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id!, frameIds: [0] }, world: 'MAIN', func: () => {
        const gateway = (globalThis as { __einfachBrowserAgentNetworkGateway__?: { dispose(): void } }).__einfachBrowserAgentNetworkGateway__
        gateway?.dispose()
        delete (globalThis as { __einfachBrowserAgentNetworkGateway__?: unknown }).__einfachBrowserAgentNetworkGateway__
      } })
    } catch { /* Restricted or already-closed tabs require no cleanup. */ }
  }))
}

function isAllowedPattern(pattern: string): boolean {
  if (SERVICE_ORIGINS.has(pattern)) return false
  return pattern === '<all_urls>' || pattern.startsWith('http://') || pattern.startsWith('https://') || pattern.startsWith('*://')
}
function matches(pattern: string, url: string): boolean {
  try {
    const parsed = new URL(url)
    if (pattern === '<all_urls>') return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    const match = /^(\*|https?|file):\/\/([^/]+)(\/.*)$/.exec(pattern)
    if (!match) return false
    const [, scheme, host] = match
    if (scheme !== '*' && `${scheme}:` !== parsed.protocol) return false
    if (scheme === '*' && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return host === '*' || host === parsed.hostname || (host.startsWith('*.') && (parsed.hostname === host.slice(2) || parsed.hostname.endsWith(`.${host.slice(2)}`)))
  }
  catch { return false }
}
