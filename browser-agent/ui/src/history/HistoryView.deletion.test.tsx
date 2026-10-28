import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { createBrowserAgent, type BrowserAgentClient } from '@einfach-agent/browser-agent'
import { activeSessionIdAtom, itemsAtom, sessionsAtom } from '@einfach-agent/core'
import { createIndexedDbRecoveryDriver } from '@einfach-agent/persistence-idb'
import { BrowserAgentView } from '../index'

const clients = new Set<BrowserAgentClient>()
afterEach(async () => { cleanup(); await Promise.all([...clients].map((client) => client.dispose())); clients.clear() })
async function open(namespace: string) {
  const client = await createBrowserAgent({ namespace, fetch: async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '完成' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } }) })
  clients.add(client)
  return client
}
async function configured(namespace: string) {
  const client = await open(namespace)
  const connection = await client.saveConnection({ label: '模型连接', baseUrl: 'https://example.test/v1', models: ['test'], apiKey: 'test-only' })
  await client.saveSkill({ name: '填表', description: '填表', triggers: [], content: '读取后填写', resources: {} })
  const agent = await client.saveAgent({ name: '助手', instructions: '填写', connectionId: connection.id, model: 'test', toolNames: [], skillNames: ['填表'] })
  return { client, agent }
}
function showHistory(client: BrowserAgentClient) {
  const view = render(<BrowserAgentView client={client} />)
  fireEvent.click(screen.getByRole('button', { name: '打开历史记录' }))
  return view
}

it('deletes persisted conversation history while retaining configuration and another namespace', async () => {
  const namespace = `history-ui-${crypto.randomUUID()}`
  const { client, agent } = await configured(namespace)
  const other = await configured(`${namespace}-other`)
  const id = await client.createSession(agent.id)
  const otherId = await other.client.createSession(other.agent.id)
  await client.core.sendMessage('测试记录', { sessionId: id })
  const view = render(<BrowserAgentView client={client} />)
  await screen.findByText('完成')
  await client.core.persistence.flush()
  expect(client.core.sessionAtomScope(id).getter(itemsAtom).length).toBeGreaterThan(0)
  const recovery = createIndexedDbRecoveryDriver(`einfach-browser-agent-history:${namespace}`)
  expect(await recovery.loadLatest(id)).toBeTruthy()
  const config = client.getSnapshot()
  fireEvent.click(screen.getByRole('button', { name: '打开历史记录' }))
  fireEvent.click(screen.getByLabelText('历史记录操作'))
  fireEvent.click(screen.getByRole('button', { name: '清空历史记录' }))
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  expect(Object.keys(client.core.rootStore.getter(sessionsAtom))).toEqual([id])
  fireEvent.click(screen.getByLabelText('历史记录操作'))
  fireEvent.click(screen.getByRole('button', { name: '清空历史记录' }))
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
  await screen.findByText('暂无历史记录。')
  expect(await recovery.loadLatest(id)).toBeUndefined()
  expect(client.core.sessionIds()).not.toContain(id)
  expect(client.getSnapshot()).toEqual(config)
  expect(Object.keys(other.client.core.rootStore.getter(sessionsAtom))).toEqual([otherId])
  fireEvent.click(screen.getByRole('button', { name: /返回对话/ }))
  expect(screen.queryByRole('region', { name: '当前会话' })).toBeNull()
  expect(client.core.rootStore.getter(activeSessionIdAtom)).toBe('')
  expect(screen.queryByText('测试记录')).toBeNull()
  view.unmount()
  await client.dispose(); clients.delete(client)
  const restored = await open(namespace)
  expect(Object.keys(restored.core.rootStore.getter(sessionsAtom))).toEqual([])
  expect(restored.getSnapshot()).toEqual(config)
})

it('deletes only the selected session and only the sessions included in a bulk confirmation', async () => {
  const { client, agent } = await configured(`history-target-${crypto.randomUUID()}`)
  const first = await client.createSession(agent.id)
  const second = await client.createSession(agent.id)
  client.core.renameSession(first, '第一条')
  client.core.renameSession(second, '第二条')
  showHistory(client)
  fireEvent.click(screen.getByLabelText('会话操作：第一条'))
  fireEvent.click(screen.getByRole('button', { name: '删除会话：第一条' }))
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
  await screen.findByText('已删除 1 个会话。')
  expect(Object.keys(client.core.rootStore.getter(sessionsAtom))).toEqual([second])
  fireEvent.click(screen.getByLabelText('历史记录操作'))
  fireEvent.click(screen.getByRole('button', { name: '清空历史记录' }))
  let later = ''
  await act(async () => { later = await client.createSession(agent.id) })
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
  await screen.findByText('已删除 1 个会话。')
  expect(Object.keys(client.core.rootStore.getter(sessionsAtom))).toEqual([later])
})
