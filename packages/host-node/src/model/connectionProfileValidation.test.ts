import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createModelRoutes } from './index'
import { TEST_API_KEY, useModelTestContext } from './modelTestContext.testHarness'
import type { NodeHostCommandHandler } from '../routeTable'

const context = useModelTestContext()

function route(name: 'model_connection_profile_list' | 'model_connection_profile_save'):
NodeHostCommandHandler {
  const result = createModelRoutes({ homeDir: context.home })[name]
  if (!result) throw new Error(`未注册的命令：${name}`)
  return result
}

function configPath(): string {
  return join(context.home, '.webAgent', 'config.json')
}

async function writeConfig(config: unknown): Promise<void> {
  await writeFile(configPath(), JSON.stringify(config))
}

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    id: 'profile-1',
    label: 'Third-party gateway',
    baseUrl: 'https://api.example.com/v1',
    models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat', source: 'manual' }],
    apiKey: TEST_API_KEY,
    ...overrides,
  }
}

async function failure(work: Promise<unknown>): Promise<Error & { reason?: string }> {
  return work.then(
    () => { throw new Error('预期失败，却成功了') },
    (error: unknown) => error as Error & { reason?: string },
  )
}

describe('connection profile input normalization', () => {
  it('rejects uncontrolled IDs, unbounded text, control characters, and disallowed URLs', async () => {
    const invalidInputs = [
      validInput({ id: 'UPPERCASE' }),
      validInput({ id: '../escape' }),
      validInput({ id: `a${'b'.repeat(64)}` }),
      validInput({ label: '   ' }),
      validInput({ label: 'a'.repeat(121) }),
      validInput({ models: [{ id: 'line\nbreak', label: 'Model', source: 'manual' }] }),
      validInput({ models: [{ id: 'm'.repeat(201), label: 'Model', source: 'manual' }] }),
      validInput({ models: [] }),
      validInput({ models: [{ id: 'model', label: '   ', source: 'manual' }] }),
      validInput({ models: [{ id: 'model', label: 'Model', source: 'automatic' }] }),
      validInput({ models: [{ id: 'model', label: 'Model', source: 'manual', vendor: 'x' }] }),
      validInput({ models: [
        { id: 'same', label: 'First', source: 'manual' },
        { id: 'same', label: 'Second', source: 'discovered' },
      ] }),
      validInput({ baseUrl: 'http://remote.example.com/v1' }),
    ]

    for (const input of invalidInputs) {
      await expect(route('model_connection_profile_save')({ input })).rejects.toBeTruthy()
    }
  })

  it('rejects unknown or server-owned fields and malformed command envelopes', async () => {
    for (const args of [
      {},
      { input: validInput(), extra: true },
      { input: validInput({ kind: 'openai-compatible' }) },
      { input: validInput({ credentialConfigured: true }) },
      { input: { ...validInput(), model: 'legacy-save-is-not-accepted', models: undefined } },
    ]) {
      const error = await failure(route('model_connection_profile_save')(args))
      expect(error.reason).toBe('invalid-request')
      expect(error.message).not.toContain(TEST_API_KEY)
    }
    await expect(route('model_connection_profile_list')({ extra: true })).rejects.toMatchObject({
      reason: 'invalid-request',
    })
  })

  it('requires a key for a new or credential-less profile and never writes metadata on failure', async () => {
    const { apiKey: _apiKey, ...input } = validInput()

    const error = await failure(route('model_connection_profile_save')({ input }))
    expect(error.reason).toBe('credential-missing')
    expect(error.message).not.toContain(TEST_API_KEY)
    expect(JSON.parse(await readFile(configPath(), 'utf8')).modelConnections).toBeUndefined()
  })

  it('rejects an invalid supplied key without echoing it or replacing a saved key', async () => {
    await route('model_connection_profile_save')({ input: validInput() })
    const secretProbe = `private-invalid-key-probe-${'x'.repeat(1_024)}`
    const error = await failure(route('model_connection_profile_save')({
      input: validInput({ label: 'Changed', apiKey: secretProbe }),
    }))

    expect(error.reason).toBe('invalid-request')
    expect(error.message).not.toContain('private-invalid-key-probe')
    const config = JSON.parse(await readFile(configPath(), 'utf8'))
    expect(config.modelConnections['profile-1'].label).toBe('Third-party gateway')
    expect(config.modelCredentials['openai-compat:profile:profile-1']).toBe(TEST_API_KEY)
  })
})

describe('connection profile config decoding', () => {
  it('migrates legacy model records in memory without rewriting until the next save', async () => {
    const legacy = {
      version: 1,
      modelConnections: {
        'profile-1': {
          id: 'profile-1', label: 'Profile', kind: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1', model: 'legacy-model',
        },
      },
      modelCredentials: { 'openai-compat:profile:profile-1': TEST_API_KEY },
    }
    await writeConfig(legacy)

    await expect(route('model_connection_profile_list')({})).resolves.toMatchObject([{
      models: [{ id: 'legacy-model', label: 'legacy-model', source: 'manual' }],
    }])
    expect(JSON.parse(await readFile(configPath(), 'utf8'))).toEqual(legacy)

    await route('model_connection_profile_save')({ input: validInput({ apiKey: undefined }) })
    const stored = JSON.parse(await readFile(configPath(), 'utf8')).modelConnections['profile-1']
    expect(stored).toHaveProperty('models')
    expect(stored).not.toHaveProperty('model')
  })

  it('fails closed for malformed modelConnections sections and entries', async () => {
    const malformedSections = [
      [],
      { 'profile-1': null },
      { 'profile-1': { ...validInput(), kind: 'openai-compatible' } },
      {
        mismatched: {
          id: 'profile-1', label: 'Profile', kind: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1', model: 'model-1',
        },
      },
      {
        'profile-1': {
          id: 'profile-1', label: 'Profile', kind: 'official',
          baseUrl: 'https://api.example.com/v1', model: 'model-1',
        },
      },
      {
        'profile-1': {
          id: 'profile-1', label: 'Profile', kind: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1', models: [],
        },
      },
    ]

    for (const modelConnections of malformedSections) {
      await writeConfig({ version: 1, modelCredentials: {}, modelConnections })
      await expect(route('model_connection_profile_list')({})).rejects.toMatchObject({
        reason: 'credential-config-invalid',
      })
    }
  })

  it('a malformed credential section is not bypassed and no public result can disclose its value', async () => {
    await writeConfig({
      version: 1,
      modelConnections: {
        'profile-1': {
          id: 'profile-1', label: 'Profile', kind: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1', model: 'model-1',
        },
      },
      modelCredentials: { 'openai-compat:profile:profile-1': { secret: TEST_API_KEY } },
    })

    const error = await failure(route('model_connection_profile_list')({}))
    expect(error.reason).toBe('credential-config-invalid')
    expect(error.message).not.toContain(TEST_API_KEY)
  })
})
