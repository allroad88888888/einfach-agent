import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { itemsAtom, newSession, sessionAtomScope } from '@einfach-agent/core'
// 深路径进真实写入器：账本条目只能由 state/ 的写入器产生，而写入器不在 core 的公开面上
// （公开面只给 UI「读 atom + 调命令」）。测试要的是真账目，不是伪造的 atom 值。
import { appendItem, setRun } from '@einfach-agent/core/state/sessionWriters'
import { renderWithStore } from '../../test/renderWithStore'
import { UndoBar } from './UndoBar'

/** 走真实写入器跑一整轮，产生的账目全部带同一个轮标签。 */
function seedTurn(id: string, turnId: string, text: string) {
  setRun(id, { runId: `run-${turnId}`, status: 'running', turnId })
  appendItem(id, { id: turnId, createdAt: 1, item: { role: 'user', content: text } })
  appendItem(id, { id: `${turnId}-a`, createdAt: 2, item: { role: 'assistant', content: '答' } })
  setRun(id, { runId: `run-${turnId}`, status: 'done', turnId })
}

function renderBar(id: string) {
  // sessionUndoAvailabilityAtom 是会话 atom，必须挂到 agentStore（AgentStoreProvider）—— 挂成
  // 环境 store（`store`）会让组件的 useAgentAtomValue 读不到它，恰好复现过去的生产 bug。
  return renderWithStore(<UndoBar sessionId={id} />, { agentStore: sessionAtomScope(id) })
}

function itemIds(id: string): string[] {
  return sessionAtomScope(id).getter(itemsAtom).map((entry) => entry.id)
}

describe('UndoBar', () => {
  it('一条账都没有时整体不显示', () => {
    const id = newSession({ settings: { vendor: 'test', model: 'test-model' } })
    renderBar(id)

    expect(screen.queryByRole('button', { name: '撤销上一轮' })).toBeNull()
  })

  it('存在可撤销条目时组件真的渲染出撤销按钮', () => {
    // 单独钉住「渲染」这件事本身：上面那条「无账不显示」测的是反面，其余几条只是顺手用
    // getByRole 定位按钮去点击，都不是专门针对「有账时组件到底有没有出现在 DOM 里」的断言——
    // 万一读的 store 挂错导致 availability 恒为默认值，这条会直接失败，而不是被别的用例掩盖。
    const id = newSession({ settings: { vendor: 'test', model: 'test-model' } })
    seedTurn(id, 'u1', '第一问')
    renderBar(id)

    expect(screen.getByRole('button', { name: '撤销上一轮' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '撤销上一轮' })).toBeEnabled()
  })

  it('点撤销把最近一轮整体退回', async () => {
    const id = newSession({ settings: { vendor: 'test', model: 'test-model' } })
    seedTurn(id, 'u1', '第一问')
    seedTurn(id, 'u2', '第二问')
    renderBar(id)

    await userEvent.click(screen.getByRole('button', { name: '撤销上一轮' }))

    // 只退一轮，第一轮必须完整留下。
    expect(itemIds(id)).toEqual(['u1', 'u1-a'])
  })

  it('重做把刚撤销的那一轮放回来', async () => {
    const id = newSession({ settings: { vendor: 'test', model: 'test-model' } })
    seedTurn(id, 'u1', '第一问')
    renderBar(id)

    await userEvent.click(screen.getByRole('button', { name: '撤销上一轮' }))
    expect(itemIds(id)).toEqual([])

    await userEvent.click(screen.getByRole('button', { name: '重做' }))
    expect(itemIds(id)).toEqual(['u1', 'u1-a'])
  })

  it('run 在飞时按钮照常可点，但先说清会停止运行', () => {
    const id = newSession({ settings: { vendor: 'test', model: 'test-model' } })
    seedTurn(id, 'u1', '第一问')
    setRun(id, { runId: 'run-live', status: 'running', turnId: 'u2' })
    renderBar(id)

    // 命令会替用户把 run 停掉，所以这里不该禁用 —— 但「会停止运行」不能是暗箱动作。
    expect(screen.getByRole('button', { name: '撤销上一轮' })).toBeEnabled()
    expect(screen.getByText('会先停止当前运行')).toBeInTheDocument()
  })

  it('撤销到底之后撤销按钮自己变灰，重做仍可用', async () => {
    const id = newSession({ settings: { vendor: 'test', model: 'test-model' } })
    seedTurn(id, 'u1', '第一问')
    renderBar(id)

    await userEvent.click(screen.getByRole('button', { name: '撤销上一轮' }))

    expect(screen.getByRole('button', { name: '撤销上一轮' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '重做' })).toBeEnabled()
  })
})
