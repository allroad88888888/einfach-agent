import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { itemsAtom, pendingQuestionAnswersAtom, runAtom, sessionsAtom } from '@einfach-agent/core'
import type { ToolRegistry } from '@einfach-agent/core/tools'
import { createBrowserAgent, type BrowserAgentClient } from '@einfach-agent/browser-agent'
import { BrowserAgentView } from './index'

const clients: BrowserAgentClient[] = []
const namespace = (name: string) => `ui-${name}-${crypto.randomUUID()}`
async function client(name: string, options: { fetch?: typeof fetch; registerTools?: (registry: ToolRegistry) => void } = {}) {
  const value = await createBrowserAgent({ namespace: namespace(name), ...options })
  clients.push(value)
  return value
}
async function configured(value: BrowserAgentClient, name = '填写助手') {
  const connection = await value.saveConnection({ label: '测试连接', baseUrl: 'https://example.test/v1', models: ['test-model'], apiKey: 'secret' })
  const agent = await value.saveAgent({ name, instructions: '填写表单', connectionId: connection.id, model: 'test-model', toolNames: value.core.tools.list().map((tool) => tool.name), skillNames: [] })
  return { connection, agent }
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(clients.splice(0).map((value) => value.dispose())) })
function openSettings(section: 'Agent' | '技能' | '模型与 API Key') {
  fireEvent.click(screen.getByRole('button', { name: '打开设置' }))
  fireEvent.click(within(screen.getByRole('navigation', { name: '设置类型' })).getByRole('button', { name: section }))
}

describe('BrowserAgentView public export', () => {
  it('keeps two mounted clients isolated and unmount only releases its own subscription', async () => {
    const first = await client('first'); const second = await client('second')
    const { agent } = await configured(first)
    const one = render(<BrowserAgentView client={first} />)
    const two = render(<BrowserAgentView client={second} />)
    expect(within(one.container).getByRole('button', { name: '新建会话' })).toBeEnabled()
    expect(two.getByText('还没有 Agent')).toBeTruthy()
    const firstView = within(one.container)
    fireEvent.click(firstView.getByRole('button', { name: '新建会话' }))
    fireEvent.change(firstView.getByLabelText('使用 Agent'), { target: { value: agent.id } })
    fireEvent.click(firstView.getByRole('button', { name: '创建会话' }))
    await waitFor(() => expect(firstView.getByText('准备好了')).toBeTruthy())
    expect(Object.keys(second.core.rootStore.getter(sessionsAtom))).toHaveLength(0)
    one.unmount()
    await first.saveSkill({ name: 'after-unmount', description: 'ok', triggers: [], content: 'text', resources: {} })
    expect(two.getByText('还没有 Agent')).toBeTruthy()
  })

  it('clears the selected connection and password draft when the client changes', async () => {
    const user = userEvent.setup()
    const first = await client('connection-swap-first'); const second = await client('connection-swap-second')
    const { connection } = await configured(first)
    const view = render(<BrowserAgentView client={first} />)
    openSettings('模型与 API Key')
    fireEvent.click(screen.getByRole('button', { name: /测试连接API Key 已配置/ }))
    fireEvent.change(screen.getByLabelText('连接名称'), { target: { value: '来自 A 的草稿' } })
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'a-password-draft' } })

    view.rerender(<BrowserAgentView client={second} />)
    expect(screen.getByText('还没有 Agent')).toBeTruthy()
    expect(screen.queryByText('来自 A 的草稿')).toBeNull()
    openSettings('模型与 API Key')
    expect((screen.getByLabelText('连接名称') as HTMLInputElement).value).toBe('DeepSeek V4.1 Flash')
    expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe('')
    await user.click(screen.getByLabelText('连接名称'))
    await user.tab(); expect(screen.getByLabelText('接口地址')).toHaveFocus()
    await user.tab(); expect(screen.getByLabelText('模型 ID 列表')).toHaveFocus()
    await user.tab(); expect(screen.getByLabelText('API Key')).toHaveFocus()
    await user.tab(); expect(screen.getByRole('button', { name: '保存模型连接' })).toHaveFocus()
    fireEvent.change(screen.getByLabelText('连接名称'), { target: { value: 'B 新连接' } })
    fireEvent.change(screen.getByLabelText('接口地址'), { target: { value: 'https://second.test/v1' } })
    fireEvent.change(screen.getByLabelText('模型 ID 列表'), { target: { value: 'second-model' } })
    fireEvent.click(screen.getByRole('button', { name: '保存模型连接' }))
    await screen.findByText(/API Key 输入已清理/)
    expect(second.getSnapshot().connections).toHaveLength(1)
    expect(second.getSnapshot().connections[0]).toMatchObject({ label: 'B 新连接', credentialConfigured: false })
    expect(second.getSnapshot().connections[0]?.id).not.toBe(connection.id)
  })

  it('clears Agent editing state and connection selection when the client changes', async () => {
    const first = await client('agent-swap-first'); const second = await client('agent-swap-second')
    const { agent: firstAgent } = await configured(first, 'A Agent')
    const { connection: secondConnection } = await configured(second, 'B Agent')
    const view = render(<BrowserAgentView client={first} />)
    openSettings('Agent')
    fireEvent.click(screen.getByRole('button', { name: /A Agent/ }))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '来自 A 的 Agent 草稿' } })

    view.rerender(<BrowserAgentView client={second} />)
    expect(screen.queryByDisplayValue('来自 A 的 Agent 草稿')).toBeNull()
    openSettings('Agent')
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('连接') as HTMLSelectElement).value).toBe(secondConnection.id)
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'B 新 Agent' } })
    fireEvent.change(screen.getByLabelText('工作说明'), { target: { value: '只属于 B' } })
    fireEvent.click(screen.getByRole('button', { name: '保存 Agent' }))
    await screen.findByText(/Agent 已保存/)
    expect(second.getSnapshot().agents).toHaveLength(2)
    expect(second.getSnapshot().agents.some((agent) => agent.name === 'B 新 Agent' && agent.connectionId === secondConnection.id)).toBe(true)
    expect(second.getSnapshot().agents.some((agent) => agent.id === firstAgent.id)).toBe(false)
  })

  it('edits connection, skill resources and agent through the rendered settings forms', async () => {
    const value = await client('settings')
    render(<BrowserAgentView client={value} />)
    openSettings('模型与 API Key')
    fireEvent.change(screen.getByLabelText('连接名称'), { target: { value: '本地模型' } })
    fireEvent.change(screen.getByLabelText('接口地址'), { target: { value: 'https://model.test/v1' } })
    fireEvent.change(screen.getByLabelText('模型 ID 列表'), { target: { value: 'fast, precise' } })
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'never-render-again' } })
    fireEvent.click(screen.getByRole('button', { name: '保存模型连接' }))
    await screen.findByText(/API Key 输入已清理/)
    expect(value.getSnapshot().connections[0]).toMatchObject({ models: ['fast', 'precise'], credentialConfigured: true })
    expect(screen.queryByDisplayValue('never-render-again')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '技能' }))
    fillSkill('表单助手')
    fireEvent.click(screen.getByRole('button', { name: '添加文本资源' }))
    fireEvent.change(screen.getByLabelText('资源名称'), { target: { value: 'reference.md' } })
    fireEvent.change(screen.getByLabelText('reference.md内容'), { target: { value: '字段说明' } })
    fireEvent.click(screen.getByRole('button', { name: '保存技能' }))
    await screen.findByText(/技能已保存/)
    expect(value.getSnapshot().skills[0]?.resources).toEqual({ 'reference.md': '字段说明' })

    fireEvent.click(screen.getByRole('button', { name: 'Agent' }))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '业务助手' } })
    fireEvent.change(screen.getByLabelText('工作说明'), { target: { value: '准确填写' } })
    fireEvent.change(screen.getByLabelText('连接'), { target: { value: value.getSnapshot().connections[0]?.id } })
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'precise' } })
    fireEvent.click(screen.getByLabelText(/表单助手/))
    fireEvent.click(screen.getByRole('button', { name: '保存 Agent' }))
    await screen.findByText(/Agent 已保存/)
    expect(value.getSnapshot().agents[0]).toMatchObject({ name: '业务助手', model: 'precise', skillNames: ['表单助手'] })
  })

  it('keeps a failed save visible as an error without changing the snapshot', async () => {
    const value = await client('save-error'); await configured(value)
    render(<BrowserAgentView client={value} />)
    openSettings('模型与 API Key')
    fireEvent.change(screen.getByLabelText('连接名称'), { target: { value: '测试连接' } })
    fireEvent.change(screen.getByLabelText('接口地址'), { target: { value: 'https://other.test/v1' } })
    fireEvent.change(screen.getByLabelText('模型 ID 列表'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: '保存模型连接' }))
    await screen.findByText(/Duplicate connection label/)
    expect(value.getSnapshot().connections).toHaveLength(1)
  })

  it('runs config to session to message and renders projected tool progress and result', async () => {
    let turn = 0
    const fetchImpl: typeof fetch = async () => {
      const message = turn++ === 0
        ? { role: 'assistant', content: '我来读取页面', reasoning_content: '先检查字段', tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'fixture_read', arguments: '{"field":"name"}' } }] }
        : { role: 'assistant', content: '读取完成' }
      return new Response(JSON.stringify({ choices: [{ message, finish_reason: turn === 1 ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
    }
    const value = await client('tool-flow', { fetch: fetchImpl, registerTools(registry) { registry.register({ name: 'fixture_read', runtime: 'internal', execution: { mode: 'parallel', effectKeys: [] }, skill: { description: '读取字段', triggers: [], content: 'read' }, inputSchema: { type: 'object', properties: { field: { type: 'string' } }, required: ['field'], additionalProperties: false }, execute: () => ({ ok: true, data: { value: 'Alice' } }) }) } })
    const { agent } = await configured(value)
    render(<BrowserAgentView client={value} />)
    fireEvent.click(screen.getByRole('button', { name: '新建会话' }))
    fireEvent.change(screen.getByLabelText('使用 Agent'), { target: { value: agent.id } })
    fireEvent.click(screen.getByRole('button', { name: '创建会话' }))
    await screen.findByText('准备好了')
    fireEvent.change(screen.getByLabelText('消息'), { target: { value: '读取姓名' } }); fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await screen.findByText('读取完成')
    expect(screen.getByText('思考过程')).toBeTruthy()
    expect(screen.getByText('fixture_read')).toBeTruthy()
    expect(screen.getAllByText('已完成').length).toBeGreaterThan(0)
    expect((screen.getByLabelText('消息') as HTMLTextAreaElement).disabled).toBe(false)
  })

  it('targets the displayed session for questions, confirmation, stop and undo', async () => {
    const value = await client('commands'); const { agent } = await configured(value)
    const shown = await value.createSession(agent.id); const other = await value.createSession(agent.id)
    const shownStore = value.core.sessionAtomScope(shown); const otherStore = value.core.sessionAtomScope(other)
    shownStore.setter(runAtom, { runId: 'ask-run', status: 'waiting_user', pendingQuestion: { title: '选择方式', questions: [{ id: 'mode', text: '使用哪个模式？', type: 'single-choice', required: true, options: ['安全', '快速'] }] } })
    value.core.renameSession(shown, '目标会话')
    render(<BrowserAgentView client={value} />)
    fireEvent.click(screen.getByRole('button', { name: '打开历史记录' }))
    fireEvent.click(screen.getByRole('button', { name: '打开会话：目标会话' }))
    fireEvent.click(screen.getByRole('button', { name: '安全' }))
    expect(shownStore.getter(pendingQuestionAnswersAtom)).toEqual({ mode: '安全' })
    expect(otherStore.getter(pendingQuestionAnswersAtom)).toEqual({})
    const resume = vi.spyOn(value.core, 'resumeWithAnswers').mockImplementation(() => undefined)
    fireEvent.click(screen.getByRole('button', { name: '继续' })); expect(resume).toHaveBeenCalledWith(shown)

    shownStore.setter(runAtom, { runId: 'confirm-run', status: 'waiting_confirmation', pendingToolConfirmation: { callId: 'call', toolName: 'fill_field', args: { value: 'A' }, risk: 'dangerous' } })
    const confirm = vi.spyOn(value.core, 'confirmTool').mockImplementation(() => undefined)
    await waitFor(() => expect(screen.getByText('fill_field')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '允许本次调用' })); expect(confirm).toHaveBeenCalledWith(true, false, shown)
    const stop = vi.spyOn(value.core, 'stopRun').mockImplementation(() => undefined)
    fireEvent.click(screen.getByRole('button', { name: '停止' })); expect(stop).toHaveBeenCalledWith({ sessionId: shown })
  })

  it('applies per-message retract, composer refill and recovery only to the displayed session', async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '完成' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } })
    const value = await client('history-recovery', { fetch: fetchImpl }); const { agent } = await configured(value)
    const shown = await value.createSession(agent.id); const other = await value.createSession(agent.id)
    value.core.renameSession(shown, '目标会话')
    render(<BrowserAgentView client={value} />)
    fireEvent.click(screen.getByRole('button', { name: '打开历史记录' }))
    fireEvent.click(screen.getByRole('button', { name: '打开会话：目标会话' }))
    fireEvent.change(screen.getByLabelText('消息'), { target: { value: '只写入当前会话' } }); fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await screen.findByText('完成')
    expect(value.core.sessionAtomScope(other).getter(itemsAtom)).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: /撤销此消息及后续对话/ }))
    await waitFor(() => expect(value.core.sessionAtomScope(shown).getter(itemsAtom)).toEqual([]))
    expect(value.core.sessionAtomScope(other).getter(itemsAtom)).toEqual([])
    expect((screen.getByLabelText('消息') as HTMLTextAreaElement).value).toBe('只写入当前会话')
    expect(screen.queryByRole('button', { name: '重做' })).toBeNull()

    value.core.sessionAtomScope(shown).setter(runAtom, { runId: 'recover-run', status: 'interrupted' })
    const recover = vi.spyOn(value.core, 'continueRecoveredSession').mockReturnValue({ status: 'continued', sessionId: shown, continuation: 'interrupted_run' })
    await waitFor(() => expect(screen.getByRole('button', { name: '恢复运行' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '恢复运行' }))
    expect(recover).toHaveBeenCalledWith(shown)
  })

  it('shows stale Agent references and requires an explicit replacement or removal', async () => {
    const value = await client('stale-references')
    const retiredTool = fixtureTool('retired_tool')
    const timingTool = { ...fixtureTool('internal_timing'), callTiming: 'sessionStart' as const }
    value.core.tools.register(retiredTool)
    value.core.tools.register(timingTool)
    const { connection, agent } = await configured(value)
    value.core.tools.unregister(retiredTool.name, retiredTool)

    render(<BrowserAgentView client={value} />)
    openSettings('Agent')
    fireEvent.click(screen.getByRole('button', { name: new RegExp(agent.name) }))
    const missing = screen.getByRole('checkbox', { name: /retired_tool.*已缺失/ })
    expect((missing as HTMLInputElement).checked).toBe(true)
    const capabilityToggle = screen.getByText('工具能力').closest('summary')
    expect(capabilityToggle).toBeTruthy()
    fireEvent.click(capabilityToggle!); expect((missing as HTMLInputElement).checked).toBe(true)
    fireEvent.click(capabilityToggle!); expect((missing as HTMLInputElement).checked).toBe(true)
    expect(screen.queryByText('internal_timing')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '保存 Agent' }))
    await screen.findByText(/请先移除缺失引用：retired_tool/)
    expect(value.getSnapshot().agents[0]).toMatchObject({ revision: 1, toolNames: expect.arrayContaining(['retired_tool']) })

    fireEvent.click(missing)
    fireEvent.click(screen.getByRole('button', { name: '保存 Agent' }))
    await screen.findByText(/Agent 已保存/)
    expect(value.getSnapshot().agents[0]).toMatchObject({ revision: 2 })
    expect(value.getSnapshot().agents[0]?.toolNames).not.toContain('retired_tool')

    await value.saveConnection({ ...connection, models: ['replacement-model'] })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(agent.name) }))
    expect(screen.getByText(/当前配置引用了已不可用的模型/)).toBeTruthy()
    expect(screen.getByRole('option', { name: 'test-model（已缺失）' })).toBeTruthy()
    expect((screen.getByRole('button', { name: '保存 Agent' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'replacement-model' } })
    expect((screen.getByRole('button', { name: '保存 Agent' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('resets unsaved drafts when New is pressed again', async () => {
    const value = await client('new-draft-reset')
    render(<BrowserAgentView client={value} />)
    openSettings('Agent')
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '未保存 Agent' } })
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('')

    fireEvent.click(screen.getByRole('button', { name: '技能' }))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '未保存技能' } })
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('')

    fireEvent.click(within(screen.getByRole('navigation', { name: '设置类型' })).getByRole('button', { name: '模型与 API Key' }))
    fireEvent.change(screen.getByLabelText('连接名称'), { target: { value: '未保存连接' } })
    fireEvent.click(screen.getByRole('button', { name: '新建' }))
    expect((screen.getByLabelText('连接名称') as HTMLInputElement).value).toBe('DeepSeek V4.1 Flash')
  })
})

function fillSkill(name: string) {
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: name } })
  fireEvent.change(screen.getByLabelText('描述'), { target: { value: '协助填写表单' } })
  fireEvent.change(screen.getByLabelText('正文'), { target: { value: '先读取字段，再填写。' } })
}

function fixtureTool(name: string) {
  return {
    name,
    runtime: 'internal' as const,
    execution: { mode: 'parallel' as const, effectKeys: [] },
    skill: { description: name, triggers: [], content: name },
    inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
    execute: () => ({ ok: true as const, data: {} }),
  }
}
