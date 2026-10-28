import React from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserAgent } from '@einfach-agent/browser-agent'
import { runAtom } from '@einfach-agent/core'
import { BrowserAgentView } from '../src'
import { registerApiTools } from '@einfach-agent/tools-browser-api'
import { registerPageTools } from '@einfach-agent/tools-browser-page'
import { registerNetworkTools } from '@einfach-agent/tools-browser-network'
import { registerDomTools } from '@einfach-agent/tools-browser-dom'
import { createFixtureBusiness } from './fixture-business.testFixtures'
import { mountNetworkPreview } from './fixture-network-preview.testFixtures'
import { createFixtureModelFetch } from './fixture-model.testFixtures'
import { mountDomPreview } from './fixture-dom-preview.testFixtures'
import '../src/styles.css'

const scenario = new URLSearchParams(location.search).get('scenario') ?? 'empty'
if (new URLSearchParams(location.search).get('width') === '360') document.documentElement.classList.add('fixture-narrow')
const businessRoot = document.getElementById('business-fixture')
if (!businessRoot) throw new Error('Missing business fixture root')
const business = await createFixtureBusiness(businessRoot)
const client = await createBrowserAgent({ namespace: `fixture-${scenario}-${Date.now()}`, fetch: createFixtureModelFetch(), registerTools(registry) { registerPageTools(registry, business.pageHost); registerDomTools(registry, business.domHost); registerApiTools(registry, business.apiHost); registerNetworkTools(registry, business.networkHost) } })
if (scenario !== 'empty') {
  const connection = await client.saveConnection({ label: '演示连接', baseUrl: 'https://fixture.invalid/v1', models: ['quick-1', 'precise-1'], apiKey: 'fixture-only' })
  const skill = await client.saveSkill({ name: '表单核对', description: '核对字段并给出填写建议', triggers: ['表单'], content: '先读取，再核对。', resources: { 'fields.md': '姓名、部门、日期' } })
  const agent = await client.saveAgent({ name: '表单助手', instructions: '先读取演示业务页面，再准确、谨慎地填写并核对表单；非原生控件使用DOM工具。', connectionId: connection.id, model: 'precise-1', toolNames: ['read_page', 'read_form', 'read_field_options', 'wait_for_field', 'select_option', 'fill_fields', 'validate_form', 'read_dom', 'click_dom', 'wait_for_dom'], skillNames: [skill.name] })
  if (scenario === 'waiting' || scenario === 'running') {
    const sessionId = await client.createSession(agent.id)
    client.core.selectSession(sessionId)
    client.core.sessionAtomScope(sessionId).setter(runAtom, scenario === 'waiting' ? { runId: 'fixture-wait', status: 'waiting_user', pendingQuestion: { title: '确认填写方式', questions: [{ id: 'mode', text: '请选择提交前的核对方式', type: 'single-choice', required: true, options: ['逐项核对', '快速检查'] }] } } : { runId: 'fixture-run', status: 'running' })
  }
  if (scenario === 'history') {
    for (const title of ['核对申请单的必填项', '整理本周项目进度']) {
      const historyId = await client.createSession(agent.id)
      client.core.renameSession(historyId, title)
    }
    const sessionId = await client.createSession(agent.id)
    for (const text of ['第一轮：读取页面', '第二轮：核对字段', '第三轮：给出建议']) {
      await client.core.sendMessage({ text }, { sessionId })
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (client.core.sessionAtomScope(sessionId).getter(runAtom)?.status === 'done') break
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
    client.core.selectSession(sessionId)
  }
}
(globalThis as typeof globalThis & { __browserAgentFixture?: unknown }).__browserAgentFixture = { client, business }
mountNetworkPreview(businessRoot, client.core.tools, business)
mountDomPreview(businessRoot, client.core.tools, business)
window.addEventListener('pagehide', () => { business.dispose(); void client.dispose() }, { once: true })
createRoot(document.getElementById('root')!).render(<React.StrictMode><BrowserAgentView client={client} /></React.StrictMode>)
