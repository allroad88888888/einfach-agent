import { describe, expect, it } from 'vitest'
import type { HostInvoke } from '@einfach-agent/core'
import { createServerModelConnectionProfileHost } from './serverModelConnectionProfileHost'
import {
  createUnavailableModelConnectionProfileHost,
  type ModelConnectionProfile,
} from './modelConnectionProfileHost'

const PROFILE: ModelConnectionProfile = {
  id: 'gateway-a',
  label: 'Gateway A',
  kind: 'openai-compatible',
  baseUrl: 'https://gateway.example.com/v1',
  models: [
    { id: 'deepseek-chat', label: 'DeepSeek Chat', source: 'manual' },
    { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', source: 'discovered' },
  ],
  credentialConfigured: true,
}

describe('createServerModelConnectionProfileHost', () => {
  it('maps CRUD to the frozen host command names and payloads', async () => {
    const calls: Array<{ command: string, args?: Record<string, unknown> }> = []
    const invoke: HostInvoke = async <T>(command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args })
      if (command.endsWith('_list')) return [PROFILE] as T
      if (command.endsWith('_delete')) return { deleted: true } as T
      if (command.endsWith('_probe')) return { models: PROFILE.models } as T
      return PROFILE as T
    }
    const host = createServerModelConnectionProfileHost(invoke)
    const input = {
      id: PROFILE.id,
      label: PROFILE.label,
      baseUrl: PROFILE.baseUrl,
      models: PROFILE.models,
      apiKey: 'write-only-secret',
    }

    expect(host.available).toBe(true)
    await expect(host.list()).resolves.toEqual([PROFILE])
    await expect(host.read(PROFILE.id)).resolves.toEqual(PROFILE)
    await expect(host.save(input)).resolves.toEqual(PROFILE)
    await expect(host.delete(PROFILE.id)).resolves.toEqual({ deleted: true })
    await expect(host.probe({ baseUrl: PROFILE.baseUrl, apiKey: 'write-only-secret' }))
      .resolves.toEqual({ models: PROFILE.models })
    expect(calls).toEqual([
      { command: 'model_connection_profile_list', args: undefined },
      { command: 'model_connection_profile_read', args: { id: PROFILE.id } },
      { command: 'model_connection_profile_save', args: { input } },
      { command: 'model_connection_profile_delete', args: { id: PROFILE.id } },
      {
        command: 'model_connection_profile_probe',
        args: { input: { baseUrl: PROFILE.baseUrl, apiKey: 'write-only-secret' } },
      },
    ])
    expect(JSON.stringify(PROFILE)).not.toContain('write-only-secret')
  })

  it('keeps probing unavailable on static deployments', async () => {
    const host = createUnavailableModelConnectionProfileHost()
    expect(host.available).toBe(false)
    await expect(host.probe({ baseUrl: PROFILE.baseUrl })).rejects.toThrow('本机后端')
  })
})
