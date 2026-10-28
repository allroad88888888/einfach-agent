import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createBrowserAgent, type BrowserAgentClient } from '@einfach-agent/browser-agent'
import { activeSessionIdAtom, runAtom, sessionsAtom } from '@einfach-agent/core'
import { ExtensionApp } from '../src/app'
import { ExtensionPageBridge } from '../src/page-bridge'
import { createSessionPageHost } from '../src/session-page-host'
import type { TargetBinding } from '../src/protocol'

const clients = new Set<BrowserAgentClient>()
const tabs = new Map<number, chrome.tabs.Tab>()
const target: TargetBinding = { tabId: 7, frameId: 0, targetId: 'main-frame', documentId: 'doc-7', revision: 1, title: '申请页面', url: 'https://example.test/apply?id=1' }
let storage: Record<string, unknown>
const send = vi.fn()
const write = vi.fn()
let updated: (id: number, change: { status?: string; url?: string }, tab: chrome.tabs.Tab) => void
let removed: (id: number) => void
beforeEach(() => {
  storage = {}; tabs.clear(); vi.clearAllMocks(); send.mockReset(); write.mockReset()
  tabs.set(7, { id: 7, windowId: 1, index: 0, active: true, title: '申请页面', url: target.url })
  tabs.set(8, { id: 8, windowId: 1, index: 1, active: false, title: '另一份相同页面', url: target.url })
  send.mockImplementation(async (message) => ({ ok: true, data: { ...target, tabId: message.tabId, documentId: `doc-${message.tabId}`, title: tabs.get(message.tabId)?.title ?? target.title, url: tabs.get(message.tabId)?.url } }))
  write.mockImplementation(async (values) => { Object.assign(storage, structuredClone(values)) })
  vi.stubGlobal('chrome', {
    runtime: { sendMessage: send },
    tabs: { query: async (query: { active?: boolean }) => [...tabs.values()].filter((tab) => !query.active || tab.active), get: async (id: number) => { if (!tabs.has(id)) throw new Error('closed'); return tabs.get(id) }, update: vi.fn(), onUpdated: { addListener: (fn: typeof updated) => { updated = fn }, removeListener: vi.fn() }, onRemoved: { addListener: (fn: typeof removed) => { removed = fn }, removeListener: vi.fn() } },
    permissions: { contains: async () => true, request: vi.fn() },
    storage: { local: { get: async (key: string) => ({ [key]: storage[key] }), set: write } },
    windows: { update: vi.fn() },
  })
})
afterEach(async () => { cleanup(); await Promise.all([...clients].map((client) => client.dispose())); clients.clear(); vi.unstubAllGlobals() })
async function setup() {
  const namespace = `session-create-${crypto.randomUUID()}`
  const client = await createBrowserAgent({ namespace, fetch: async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '测试答复' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } }) })
  clients.add(client)
  const connection = await client.saveConnection({ label: '测试连接', baseUrl: 'https://example.test/v1', models: ['test'], apiKey: 'test-only' })
  const agent = await client.saveAgent({ name: '测试助手', instructions: '测试', connectionId: connection.id, model: 'test', toolNames: [], skillNames: [] })
  const bridge = new ExtensionPageBridge()
  return { namespace, client, agent, bridge }
}
async function newSession() {
  fireEvent.click(screen.getByRole('button', { name: '新建会话' }))
  await waitFor(() => expect(screen.getByLabelText('目标页面')).toHaveValue('7'))
}

it('cancels without creating history and binds the explicitly selected tab rather than the active one', async () => {
  const { client, bridge } = await setup()
  render(<ExtensionApp client={client} bridge={bridge} />)
  await newSession()
  expect(screen.getByRole('heading', { name: '新建会话' })).toHaveFocus()
  fireEvent.change(screen.getByLabelText('对话标题'), { target: { value: '取消的标题' } })
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(client.core.sessionIds()).toHaveLength(0)
  expect(send).not.toHaveBeenCalled()
  await newSession()
  fireEvent.change(screen.getByLabelText('目标页面'), { target: { value: '8' } })
  fireEvent.change(screen.getByLabelText('对话标题'), { target: { value: '九月申请核对' } })
  fireEvent.click(screen.getByRole('button', { name: '创建会话' }))
  await screen.findByText('准备好了')
  const id = client.core.rootStore.getter(activeSessionIdAtom)
  expect(bridge.target(id)).toMatchObject({ tabId: 8, documentId: 'doc-8' })
  expect(client.core.rootStore.getter(sessionsAtom)[id]?.title).toBe('九月申请核对')
  fireEvent.change(screen.getByLabelText('消息'), { target: { value: '不要覆盖我的标题' } })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  await screen.findByText('测试答复')
  expect(client.core.rootStore.getter(sessionsAtom)[id]?.title).toBe('九月申请核对')
  fireEvent.click(screen.getByRole('button', { name: '打开历史记录' }))
  expect(within(screen.getByRole('region', { name: '会话历史' })).getByText(/另一份相同页面.*example.test/)).toBeInTheDocument()
})

it('keeps the form and title after a navigation race, then retries the newly selected URL', async () => {
  const { client, bridge } = await setup(); render(<ExtensionApp client={client} bridge={bridge} />)
  await newSession()
  fireEvent.change(screen.getByLabelText('对话标题'), { target: { value: '保留标题' } })
  tabs.set(7, { ...tabs.get(7), url: 'https://example.test/apply?id=2' })
  fireEvent.click(screen.getByRole('button', { name: '创建会话' }))
  await screen.findByText(/所选页面地址已变化/)
  expect(client.core.sessionIds()).toHaveLength(0)
  expect(screen.getByLabelText('对话标题')).toHaveValue('保留标题')
  fireEvent.click(screen.getByRole('button', { name: '刷新页面列表' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '创建会话' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '创建会话' }))
  await screen.findByText('准备好了')
  expect(bridge.target(client.core.rootStore.getter(activeSessionIdAtom))?.url).toBe('https://example.test/apply?id=2')
})

it('does not create a session if the selected tab closes or binding persistence fails', async () => {
  const { client, agent, bridge } = await setup()
  const host = createSessionPageHost(client, bridge)
  const page = (await host.listPages())[0]!
  tabs.delete(7)
  await expect(host.createSession(agent.id, { page })).rejects.toThrow(/已关闭/)
  expect(client.core.sessionIds()).toHaveLength(0)
  tabs.set(7, { id: 7, url: target.url })
  const previous = await client.createSession(agent.id)
  write.mockRejectedValueOnce(new Error('storage failed'))
  await expect(host.createSession(agent.id, { page })).rejects.toThrow(/storage failed/)
  expect(client.core.rootStore.getter(activeSessionIdAtom)).toBe(previous)
  expect(client.core.sessionIds()).toEqual([previous])
})

it('retains page metadata and drafts after closure, stops an active run, and allows explicit rebinding', async () => {
  const { client, agent, bridge } = await setup()
  const id = await client.createSession(agent.id)
  await bridge.bind(id, target)
  render(<ExtensionApp client={client} bridge={bridge} />)
  fireEvent.change(screen.getByLabelText('消息'), { target: { value: '未发送的草稿' } })
  await act(async () => { client.core.sessionAtomScope(id).setter(runAtom, { runId: 'fixture-run', status: 'running' }) })
  await act(async () => { tabs.delete(7); removed(7) })
  expect(client.core.sessionAtomScope(id).getter(runAtom)?.status).toBe('stopped')
  expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
  expect(screen.getByLabelText('消息')).toHaveValue('未发送的草稿')
  fireEvent.click(screen.getByLabelText('目标页面详情'))
  expect(screen.getByText(target.url)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '重新绑定页面' }))
  await waitFor(() => expect(screen.getByLabelText('目标页面')).toBeEnabled())
  fireEvent.change(screen.getByLabelText('目标页面'), { target: { value: '8' } })
  fireEvent.click(screen.getByRole('button', { name: '确认绑定' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeEnabled())
  expect(bridge.target(id)?.tabId).toBe(8)
  expect(screen.getByLabelText('消息')).toHaveValue('未发送的草稿')
})

it('blocks unsupported current pages without creating an empty session', async () => {
  const { client, bridge } = await setup()
  tabs.set(7, { ...tabs.get(7), url: 'chrome://extensions' })
  render(<ExtensionApp client={client} bridge={bridge} />)
  await newSession()
  expect(screen.getByRole('button', { name: '创建会话' })).toBeDisabled()
  expect(screen.getByText(/此页面受浏览器限制/)).toBeInTheDocument()
  expect(client.core.sessionIds()).toHaveLength(0)
})

it('replaces the previous page details when creating from an existing conversation', async () => {
  const { client, agent, bridge } = await setup()
  await client.createSession(agent.id)
  render(<ExtensionApp client={client} bridge={bridge} />)
  await newSession()
  fireEvent.click(screen.getByRole('button', { name: '创建会话' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '新建会话' })).toBeVisible())
  expect(screen.getAllByLabelText('目标页面详情')).toHaveLength(1)
  expect(screen.queryByText('未绑定页面')).not.toBeInTheDocument()
})
