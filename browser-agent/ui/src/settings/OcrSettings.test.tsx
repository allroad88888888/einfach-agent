import 'fake-indexeddb/auto'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { createBrowserAgent, type BrowserAgentClient } from '@einfach-agent/browser-agent'
import { BrowserAgentView } from '../index'

const clients: BrowserAgentClient[] = []
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.dispose())) })

it('offers OCR as an Agent tool and saves/removes its independent credential without echoing it', async () => {
  const client = await createBrowserAgent({ namespace: `ocr-ui-${crypto.randomUUID()}` }); clients.push(client)
  render(<BrowserAgentView client={client} />)
  fireEvent.click(screen.getByRole('button', { name: '打开设置' }))
  fireEvent.click(screen.getByRole('button', { name: '工具服务' }))
  expect(screen.getByText('尚未配置 Token')).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('OCR Token'), { target: { value: 'ui-ocr-test-key' } })
  fireEvent.click(screen.getByRole('button', { name: '保存 OCR 配置' }))
  await screen.findByText('Token 已配置，不回显。')
  expect(screen.getByLabelText('OCR Token')).toHaveValue('')
  expect(JSON.stringify(client.getSnapshot())).not.toContain('ui-ocr-test-key')
  fireEvent.click(screen.getByRole('button', { name: '移除 Token' }))
  await screen.findByText('尚未配置 Token')
  fireEvent.click(screen.getByRole('button', { name: 'Agent' }))
  fireEvent.click(screen.getByText('工具能力'))
  expect(screen.getByRole('checkbox', { name: /paddle_ocr/ })).toBeInTheDocument()
})
