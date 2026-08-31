import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { uiStore } from '../../uiStore'
import { renderWithStore } from '../../test/renderWithStore'
import { closeSettingsCenter } from '../../settings/commands'
import { openSettingsCenter } from '../../settings/settingsCenterCommands'
import {
  modelConnectionProfileEntryAtom,
  openCreateModelConnectionProfileEditor,
  resetModelConnectionProfileState,
  setModelConnectionProfileDraft,
  setModelConnectionProfileProbeState,
} from '../../settings/modelConnectionProfileState'
import { resetSettingsCenterState } from '../../settings/settingsCenterState'
import { SettingsDialog } from './SettingsDialog'

HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) {
  this.setAttribute('open', '')
})
HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) {
  this.removeAttribute('open')
  this.dispatchEvent(new Event('close'))
})

function openEditorWithPassword(): void {
  openCreateModelConnectionProfileEditor(uiStore)
  setModelConnectionProfileDraft(uiStore, {
    id: 'gateway-a',
    label: 'Gateway A',
    baseUrl: 'https://gateway.example.com/v1',
    models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat', source: 'manual' }],
    apiKey: 'discard-me-on-settings-close',
  })
  openSettingsCenter('model')
}

function expectEditorClosed(): void {
  expect(uiStore.getter(modelConnectionProfileEntryAtom)).toMatchObject({
    editorMode: 'closed',
    draft: { id: '', label: '', baseUrl: '', models: [], apiKey: '' },
    probe: { status: 'idle' },
  })
}

function renderOpenDialog(): HTMLDialogElement {
  openEditorWithPassword()
  renderWithStore(<SettingsDialog launchButtonRef={createRef<HTMLButtonElement>()} />, { store: uiStore })
  return screen.getByRole('dialog')
}

describe('SettingsDialog close paths', () => {
  beforeEach(() => {
    resetModelConnectionProfileState(uiStore)
    resetSettingsCenterState(uiStore)
  })

  afterEach(() => {
    resetModelConnectionProfileState(uiStore)
    resetSettingsCenterState(uiStore)
  })

  it('clears the probe result through closeSettingsCenter', () => {
    openEditorWithPassword()
    setModelConnectionProfileProbeState(uiStore, { status: 'ready', models: [] })

    closeSettingsCenter()

    expectEditorClosed()
  })

  it('abandons the password draft from the close button', async () => {
    renderOpenDialog()
    setModelConnectionProfileProbeState(uiStore, { status: 'ready', models: [] })

    fireEvent.click(screen.getByRole('button', { name: '关闭设置' }))

    await waitFor(expectEditorClosed)
  })

  it('abandons the password draft from Escape', async () => {
    const dialog = renderOpenDialog()

    fireEvent(dialog, new Event('cancel', { cancelable: true }))

    await waitFor(expectEditorClosed)
  })

  it('abandons the password draft from the dialog backdrop', async () => {
    const dialog = renderOpenDialog()

    fireEvent.mouseDown(dialog, { clientX: 1, clientY: 1 })

    await waitFor(expectEditorClosed)
  })
})
