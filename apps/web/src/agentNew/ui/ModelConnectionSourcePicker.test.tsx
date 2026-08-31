import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { modelConnectionPresets } from '../../settings/modelConnectionPresetRegistry'
import { renderWithStore } from '../../test/renderWithStore'
import { ModelConnectionSourcePicker } from './ModelConnectionSourcePicker'

describe('ModelConnectionSourcePicker', () => {
  it('groups presets and returns a public preset without a key', async () => {
    const onSelect = vi.fn()
    renderWithStore(<ModelConnectionSourcePicker presets={modelConnectionPresets()} onSelect={onSelect} onImport={vi.fn()} />)
    expect(screen.getByText('云端服务商')).toBeInTheDocument()
    expect(screen.getByText('自部署')).toBeInTheDocument()
    expect(screen.getByText('本地')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'OpenRouter' }))
    expect(onSelect.mock.calls[0][0]).not.toHaveProperty('apiKey')
  })

  it('passes the selected JSON file to the local importer', async () => {
    const onImport = vi.fn()
    renderWithStore(<ModelConnectionSourcePicker presets={[]} onSelect={vi.fn()} onImport={onImport} />)
    const file = new File(['{}'], 'connection.json', { type: 'application/json' })
    await userEvent.upload(screen.getByLabelText('导入 JSON'), file)
    expect(onImport).toHaveBeenCalledWith(file)
  })
})
