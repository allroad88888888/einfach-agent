import React from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserAgent } from '@einfach-agent/browser-agent'
import { runAtom } from '@einfach-agent/core'
import { BrowserAgentView } from '../src'
import '../src/styles.css'

const scenario = new URLSearchParams(location.search).get('scenario') ?? 'empty'
const client = await createBrowserAgent({ namespace: `fixture-${scenario}-${Date.now()}` })
if (scenario !== 'empty') {
  const connection = await client.saveConnection({ label: '演示连接', baseUrl: 'https://fixture.invalid/v1', models: ['precise-1'], apiKey: 'fixture-only' })
  const skill = await client.saveSkill({ name: '表单核对', description: '核对字段并给出填写建议', triggers: ['表单'], content: '先读取，再核对。', resources: { 'fields.md': '姓名、部门、日期' } })
  const agent = await client.saveAgent({ name: '表单助手', instructions: '准确、谨慎地填写页面表单。', connectionId: connection.id, model: 'precise-1', toolNames: [], skillNames: [skill.name] })
  if (scenario === 'waiting' || scenario === 'running') {
    const sessionId = await client.createSession(agent.id)
    client.core.selectSession(sessionId)
    client.core.sessionAtomScope(sessionId).setter(runAtom, scenario === 'waiting' ? { runId: 'fixture-wait', status: 'waiting_user', pendingQuestion: { title: '确认填写方式', questions: [{ id: 'mode', text: '请选择提交前的核对方式', type: 'single-choice', required: true, options: ['逐项核对', '快速检查'] }] } } : { runId: 'fixture-run', status: 'running' })
  }
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><BrowserAgentView client={client} /></React.StrictMode>)
