import { newSession } from '@einfach-agent/core'
import { useAtomValue } from '@einfach/react'
import { useLingui } from '@lingui/react/macro'
import { clearDefaultModelConnectionIfMatching, closeSettingsCenter, setDefaultModelConnection } from '../../settings/commands'
import {
  addManualModelConnectionProfileModel, deleteModelConnectionProfile, openCreateModelConnectionProfileEditor,
  openEditModelConnectionProfileEditor, probeModelConnectionProfile, removeModelConnectionProfileModel,
  replaceModelConnectionProfileModels, resetModelConnectionProfileEditor, saveModelConnectionProfile,
  updateModelConnectionProfileDraft,
} from '../../settings/modelConnectionProfileCommands'
import { parseModelConnectionProfileManifest } from '../../settings/modelConnectionProfileManifest'
import { modelConnectionPresets, type ModelConnectionPreset } from '../../settings/modelConnectionPresetRegistry'
import { modelConnectionProfileEntryAtom, setModelConnectionProfileState } from '../../settings/modelConnectionProfileState'
import { defaultModelConnectionAtom } from '../../settings/state'
import { uiStore } from '../../uiStore'
import type { ConnectionProfileModel, ModelConnectionProfile } from '../../settings/modelConnectionProfileHost'
import { ModelConnectionModelPicker } from './ModelConnectionModelPicker'
import { ModelConnectionProfileEditor } from './ModelConnectionProfileEditor'
import { ModelConnectionProfilesPanel } from './ModelConnectionProfilesPanel'
import { ModelConnectionSourcePicker } from './ModelConnectionSourcePicker'

function startProfileSession(profile: ModelConnectionProfile, model: ConnectionProfileModel): void {
  newSession({ title: `${profile.label} · ${model.label}`, settings: {
    vendor: 'openai-compat', model: model.id, vendorSettings: { connectionId: profile.id },
  } })
  closeSettingsCenter()
}

/** Binds connection-center views to Einfach commands and safe parsers. */
export function ModelConnectionProfileSettings() {
  const { t } = useLingui()
  const entry = useAtomValue(modelConnectionProfileEntryAtom)
  const selected = useAtomValue(defaultModelConnectionAtom)
  const applyPreset = (preset: ModelConnectionPreset) => updateModelConnectionProfileDraft({
    label: preset.label, baseUrl: preset.baseUrl, models: preset.models, apiKey: '',
  })
  const saveProfile = async () => {
    const editedDefault = entry.editorMode === 'edit' && selected?.id === entry.draft.id
    const keepsDefault = editedDefault && entry.draft.models.some((model) => model.id === selected.model)
    if (await saveModelConnectionProfile() && editedDefault && !keepsDefault) clearDefaultModelConnectionIfMatching(entry.draft.id)
  }
  const deleteProfile = async (profile: ModelConnectionProfile) => {
    if (await deleteModelConnectionProfile(profile.id)) clearDefaultModelConnectionIfMatching(profile.id)
  }
  const discovered = entry.probe.status === 'ready' ? entry.probe.models : []
  const probeError = entry.probe.status === 'error' ? entry.probe.error : undefined
  const stateError = entry.state.status === 'error' ? entry.state.error : undefined
  const importManifest = (file: File): void => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const imported = parseModelConnectionProfileManifest(String(reader.result ?? ''))
        updateModelConnectionProfileDraft({ label: imported.label, baseUrl: imported.baseUrl, models: imported.models, apiKey: '' })
      } catch {
        setModelConnectionProfileState(uiStore, { status: 'error', error: t`无法导入连接清单，请检查 JSON 格式和内容。` })
      }
    }
    reader.onerror = () => setModelConnectionProfileState(uiStore, { status: 'error', error: t`无法读取连接清单。` })
    reader.readAsText(file)
  }
  return <div className="agentnew-model-profile-settings">
    <ModelConnectionProfilesPanel profiles={entry.profiles} current={selected}
      onNewProfile={openCreateModelConnectionProfileEditor}
      onEditProfile={(profile) => { openEditModelConnectionProfileEditor(profile.id) }}
      onDeleteProfile={(profile) => { void deleteProfile(profile) }} onUseModel={startProfileSession}
      onSetDefaultModel={(profile, model) => setDefaultModelConnection({ id: profile.id, model: model.id })} />
    {entry.editorMode !== 'closed' ? <ModelConnectionProfileEditor mode={entry.editorMode} id={entry.draft.id}
      label={entry.draft.label} baseUrl={entry.draft.baseUrl} apiKey={entry.draft.apiKey}
      probing={entry.probe.status === 'loading'} error={stateError}
      onChange={(field, value) => updateModelConnectionProfileDraft({ [field]: value })}
      onProbe={() => { void probeModelConnectionProfile() }} onSave={() => { void saveProfile() }} onCancel={resetModelConnectionProfileEditor}>
      {entry.editorMode === 'create' ? <ModelConnectionSourcePicker presets={modelConnectionPresets()} onSelect={applyPreset} onImport={importManifest} /> : null}
      <ModelConnectionModelPicker selected={entry.draft.models} discovered={discovered} probeError={probeError}
        onAdd={(id) => {
          const found = discovered.find((model) => model.id === id)
          if (found) replaceModelConnectionProfileModels([...entry.draft.models.filter((model) => model.id !== id), found])
          else addManualModelConnectionProfileModel(id)
        }} onRemove={removeModelConnectionProfileModel} />
    </ModelConnectionProfileEditor> : null}
    {entry.editorMode === 'closed' && stateError ? <p className="agentnew-instructions-status is-error" role="alert">{stateError}</p> : null}
  </div>
}
