import type { SessionPage } from '@einfach-agent/browser-agent'
import { CHANNEL, isTarget, type ExtensionResponse, type TargetBinding } from './protocol'

export async function bindActiveTab(): Promise<TargetBinding> {
  const currentTabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const [tab] = currentTabs.length > 0 ? currentTabs : await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab || !isTabId(tab.id)) throw new Error('没有可绑定的活动网页，请先打开目标网页再重试。')
  return connectTab(tab)
}

export async function bindSelectedTab(page: SessionPage): Promise<TargetBinding> {
  const tab = await chrome.tabs.get(Number(page.id)).catch(() => { throw new Error('所选页面已关闭，请重新选择。') })
  if (tab.url !== page.url) throw new Error('所选页面地址已变化，请刷新页面列表后重新选择。')
  if (tab.status === 'loading' || (tab.pendingUrl && tab.pendingUrl !== tab.url)) throw new Error('所选页面正在跳转，请加载完成后刷新页面列表。')
  return connectTab(tab)
}

async function connectTab(tab: chrome.tabs.Tab): Promise<TargetBinding> {
  if (!isTabId(tab.id)) throw new Error('无效的标签页。')
  if (!tab.url) {
    const fallback = '请在目标网页点击工具栏的插件图标，再重试；确认目标是普通 HTTP/HTTPS 网页。'
    if (!chrome.permissions.addHostAccessRequest) throw new Error(fallback)
    try {
      await chrome.permissions.addHostAccessRequest({ tabId: tab.id })
    } catch { throw new Error(fallback) }
    throw new Error('请在 Chrome 工具栏的扩展菜单中允许此插件访问当前网站，然后再次新建会话。若没有授权入口，请在目标网页点击工具栏的插件图标后重试。')
  }
  let url: URL
  try { url = new URL(tab.url) } catch { throw new Error('当前网页地址无效，无法绑定。') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('当前页面受浏览器限制，无法绑定；请打开普通 HTTP/HTTPS 网页后重试。')
  const originPattern = `${url.origin}/*`
  const allowed = await chrome.permissions.contains({ origins: [originPattern] }) || await chrome.permissions.request({ origins: [originPattern] })
  if (!allowed) throw new Error(`未获得 ${url.origin} 的网站访问权限，无法绑定。`)
  const response = await chrome.runtime.sendMessage({ channel: CHANNEL, kind: 'handshake', tabId: tab.id, frameId: 0 }) as ExtensionResponse
  if (!response?.ok) throw new Error('无法连接目标网页，请刷新页面后重试。')
  if (!isTarget(response.data)) throw new Error('目标网页返回了无效的绑定信息。')
  if (response.data.tabId !== tab.id || response.data.frameId !== 0) throw new Error('目标网页与请求绑定的页面不匹配。')
  if (response.data.url !== tab.url) throw new Error('页面已跳转，与选择的地址不匹配；请刷新页面列表后重试。')
  return response.data
}

function isTabId(value: unknown): value is number { return Number.isInteger(value) && (value as number) >= 0 }
