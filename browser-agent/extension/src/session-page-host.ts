import type { BrowserAgentClient, SessionPage, SessionPageHost } from '@einfach-agent/browser-agent'
import { activeSessionIdAtom, runAtom, sessionsAtom } from '@einfach-agent/core'
import type { ExtensionPageBridge } from './page-bridge'
import { bindSelectedTab } from './tab-targets'

export function createSessionPageHost(client: BrowserAgentClient, bridge: ExtensionPageBridge): SessionPageHost {
  return {
    async listPages() {
      const [tabs, active] = await Promise.all([chrome.tabs.query({}), chrome.tabs.query({ active: true, currentWindow: true })])
      return tabs.filter((tab) => Number.isInteger(tab.id) && tab.id! >= 0).map((tab): SessionPage => ({
        id: String(tab.id), title: tab.title || (tab.url ? '未命名页面' : '不可访问的页面'), url: tab.url ?? '',
        active: tab.id === active[0]?.id,
        detail: `${tab.windowId === active[0]?.windowId ? '当前窗口' : '其他窗口'} · 第 ${(tab.index ?? 0) + 1} 个标签页`,
        ...(!tab.url ? { unavailableReason: '请选择普通网页。未授权的网站需先切到该页，点击插件图标授权，再刷新列表；浏览器内置页面无法绑定。' }
          : !/^https?:\/\//.test(tab.url) ? { unavailableReason: '此页面受浏览器限制，请选择普通网页。' }
            : tab.status === 'loading' ? { unavailableReason: '页面正在加载，请稍后刷新列表。' } : {}),
      })).sort((a, b) => Number(b.active) - Number(a.active))
    },
    async createSession(agentId, options) {
      const binding = await bindSelectedTab(options.page)
      const previous = client.core.rootStore.getter(activeSessionIdAtom)
      const id = await client.createSession(agentId, { title: options.title })
      try { await bridge.bind(id, binding); return id }
      catch (error) {
        await client.deleteSessions([id])
        if (client.core.rootStore.getter(sessionsAtom)[previous]) client.core.selectSession(previous)
        throw error
      }
    },
    getSessionPage: (id) => bridge.context(id),
    subscribe: (listener) => bridge.subscribe(listener),
    async bindSession(id, page) {
      const assertIdle = () => {
        if (!client.core.rootStore.getter(sessionsAtom)[id]) throw new Error('会话已被删除。')
        const run = client.core.sessionAtomScope(id).getter(runAtom)
        if (run && ['running', 'awaiting_tool', 'waiting_confirmation', 'waiting_user', 'waiting_plan_approval'].includes(run.status)) throw new Error('请先停止或完成当前运行，再更换页面。')
      }
      assertIdle()
      const binding = await bindSelectedTab(page)
      assertIdle()
      await bridge.bind(id, binding)
    },
    async revealPage(id) {
      const page = bridge.context(id)?.page
      if (!page) throw new Error('此会话还没有目标页面。')
      const tab = await chrome.tabs.get(Number(page.id)).catch(() => { throw new Error('原标签页已关闭，请重新选择页面。') })
      await chrome.tabs.update(Number(page.id), { active: true })
      if (typeof tab.windowId === 'number') await chrome.windows.update(tab.windowId, { focused: true })
    },
  }
}
