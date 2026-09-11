import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderWithStore } from '../../test/renderWithStore'
import { ModelConnectionModelPicker } from './ModelConnectionModelPicker'

describe('ModelConnectionModelPicker', () => {
  it('adds discovered or manual models only after an explicit action', async () => {
    const onAdd = vi.fn()
    renderWithStore(<ModelConnectionModelPicker selected={[]} discovered={[
      { id: 'found', label: 'Found', source: 'discovered' },
    ]} onAdd={onAdd} onRemove={vi.fn()} onImageInputChange={vi.fn()} />)
    expect(onAdd).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Found' }))
    await userEvent.type(screen.getByLabelText('手动模型 ID'), 'manual')
    await userEvent.click(screen.getByRole('button', { name: '添加模型' }))
    expect(onAdd.mock.calls.map(([id]) => id)).toEqual(['found', 'manual'])
  })

  it('shows selected models, removal, and probe errors without secrets', async () => {
    const onRemove = vi.fn()
    const onImageInputChange = vi.fn()
    renderWithStore(<ModelConnectionModelPicker selected={[
      { id: 'chosen', label: 'Chosen', source: 'manual' },
    ]} discovered={[]} probeError="探测失败" onAdd={vi.fn()} onRemove={onRemove}
      onImageInputChange={onImageInputChange} />)
    expect(screen.getByRole('alert')).toHaveTextContent('探测失败')
    await userEvent.click(screen.getByRole('checkbox', { name: '图片输入' }))
    expect(onImageInputChange).toHaveBeenCalledWith('chosen', true)
    await userEvent.click(screen.getByRole('button', { name: '移除模型 chosen' }))
    expect(onRemove).toHaveBeenCalledWith('chosen')
  })
})
