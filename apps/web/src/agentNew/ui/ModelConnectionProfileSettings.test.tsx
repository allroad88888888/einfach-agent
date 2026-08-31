import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openCreateModelConnectionProfileEditor } from '../../settings/modelConnectionProfileCommands'
import {
  modelConnectionProfileEntryAtom,
  resetModelConnectionProfileState,
} from '../../settings/modelConnectionProfileState'
import { renderWithStore } from '../../test/renderWithStore'
import { uiStore } from '../../uiStore'
import { ModelConnectionProfileSettings } from './ModelConnectionProfileSettings'

const VALID_MANIFEST = JSON.stringify({
  version: 1,
  connection: {
    label: 'Imported Gateway',
    kind: 'openai-compatible',
    baseUrl: 'https://gateway.example.com/v1/',
    models: [{ id: 'imported-model', label: 'Imported Model' }],
  },
})

function installFileReader(options: { result?: string; error?: boolean }): void {
  class FakeFileReader {
    result: string | ArrayBuffer | null = null
    onload: null | (() => void) = null
    onerror: null | (() => void) = null

    readAsText(): void {
      if (options.error) {
        this.onerror?.()
        return
      }
      this.result = options.result ?? ''
      this.onload?.()
    }
  }
  vi.stubGlobal('FileReader', FakeFileReader)
}

function importJson(name = 'connection.json'): void {
  const input = screen.getByLabelText('导入 JSON')
  fireEvent.change(input, { target: { files: [new File(['unused'], name)] } })
}

describe('ModelConnectionProfileSettings manifest binding', () => {
  beforeEach(() => {
    resetModelConnectionProfileState(uiStore)
    openCreateModelConnectionProfileEditor()
  })

  afterEach(() => vi.unstubAllGlobals())

  it('prefills only public manifest fields and keeps the local key empty', () => {
    installFileReader({ result: VALID_MANIFEST })
    renderWithStore(<ModelConnectionProfileSettings />, { store: uiStore })
    importJson()

    expect(screen.getByLabelText('名称')).toHaveValue('Imported Gateway')
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://gateway.example.com/v1')
    expect(screen.getByText('imported-model')).toBeInTheDocument()
    expect(screen.getByLabelText('API Key（写入后不会显示）')).toHaveValue('')
    expect(uiStore.getter(modelConnectionProfileEntryAtom).draft).toMatchObject({
      label: 'Imported Gateway',
      baseUrl: 'https://gateway.example.com/v1',
      models: [{ id: 'imported-model', label: 'Imported Model', source: 'manual' }],
      apiKey: '',
    })
  })

  it.each([
    JSON.stringify({ ...JSON.parse(VALID_MANIFEST), apiKey: 'secret' }),
    JSON.stringify({ ...JSON.parse(VALID_MANIFEST), unexpected: true }),
  ])('keeps the editor open and shows a generic error for rejected input', (result) => {
    installFileReader({ result })
    renderWithStore(<ModelConnectionProfileSettings />, { store: uiStore })
    importJson()

    expect(screen.getByRole('form', { name: '新建模型连接' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('无法导入连接清单，请检查 JSON 格式和内容。')
    expect(screen.getByRole('alert')).not.toHaveTextContent('secret')
  })

  it('keeps the editor open and shows a generic FileReader error', () => {
    installFileReader({ error: true })
    renderWithStore(<ModelConnectionProfileSettings />, { store: uiStore })
    importJson('unreadable.json')

    expect(screen.getByRole('form', { name: '新建模型连接' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('无法读取连接清单。')
  })
})
