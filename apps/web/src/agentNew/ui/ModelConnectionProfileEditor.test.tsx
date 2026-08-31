import { describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithStore } from '../../test/renderWithStore'
import { ModelConnectionProfileEditor } from './ModelConnectionProfileEditor'

function renderEditor(mode: 'create' | 'edit' = 'create') {
  return renderWithStore(
    <ModelConnectionProfileEditor
      mode={mode}
      id="team-gateway"
      label="团队网关"
      baseUrl="https://gateway.example/v1"
      apiKey=""
      onChange={vi.fn()}
      onProbe={vi.fn()}
      onSave={vi.fn()}
      onCancel={vi.fn()}
    />,
  )
}

describe('ModelConnectionProfileEditor', () => {
  it('renders accessible controlled fields and keeps the saved key write-only', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderWithStore(
      <ModelConnectionProfileEditor
        mode="create"
        id="team-gateway"
        label="团队网关"
        baseUrl="https://gateway.example/v1"
        apiKey=""
        onChange={onChange}
        onProbe={vi.fn()}
        onSave={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    const key = screen.getByLabelText('API Key（写入后不会显示）')
    expect(key).toHaveAttribute('type', 'password')
    expect(key).toHaveValue('')
    expect(screen.getByText(/保存成功后不会回显/)).toBeInTheDocument()

    fireEvent.change(key, { target: { value: 'secret-key' } })
    expect(onChange).toHaveBeenLastCalledWith('apiKey', 'secret-key')
  })

  it('locks the stable ID while editing and reports save/cancel/status/error', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const onCancel = vi.fn()
    renderWithStore(
      <ModelConnectionProfileEditor
        mode="edit"
        id="team-gateway"
        label="团队网关"
        baseUrl="https://gateway.example/v1"
        apiKey=""
        status="正在保存"
        error="保存失败"
        onChange={vi.fn()}
        onProbe={vi.fn()}
        onSave={onSave}
        onCancel={onCancel}
      />,
    )

    expect(screen.getByLabelText('连接 ID')).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('正在保存')
    expect(screen.getByRole('alert')).toHaveTextContent('保存失败')
    await user.click(screen.getByRole('button', { name: '保存编辑' }))
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(onSave).toHaveBeenCalledOnce()
    expect(onCancel).toHaveBeenCalledOnce()
  })
})
