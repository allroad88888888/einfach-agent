import { defaultCore } from '@einfach-agent/core'
import { uiStore } from '../uiStore'
import { appSettingsAtom } from './state'
import {
  modelConnectionProfileEntryAtom,
  modelConnectionProfileHostAvailableAtom,
} from './modelConnectionProfileState'

/** Applies a verified public profile to future-session runtime defaults without persisting changes. */
export function synchronizeDefaultModelConnectionRuntime(): boolean {
  const selected = uiStore.getter(appSettingsAtom).defaultModelConnection
  const available = uiStore.getter(modelConnectionProfileHostAvailableAtom)
  const entry = uiStore.getter(modelConnectionProfileEntryAtom)
  const verified = entry.state.status === 'ready' || entry.state.status === 'saved'
  const profile = available && verified && selected
    ? entry.profiles.find((candidate) => candidate.id === selected.id)
    : undefined

  const model = profile?.models.find((candidate) => candidate.id === selected?.model)
  defaultCore.config.defaultModelSettings = profile === undefined || model === undefined
    ? undefined
    : {
        vendor: 'openai-compat',
        model: model.id,
        vendorSettings: { connectionId: profile.id },
      }
  return profile !== undefined && model !== undefined
}
