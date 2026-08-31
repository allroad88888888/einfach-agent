import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createConnectionProfileProbeHandler } from './connectionProfileCommands'
import { createModelRoutes } from './index'
import { TEST_API_KEY, useModelTestContext } from './modelTestContext.testHarness'
import type { NodeHostCommandHandler } from '../routeTable'

const context = useModelTestContext()

type ProfileCommand =
  | 'model_connection_profile_list'
  | 'model_connection_profile_read'
  | 'model_connection_profile_save'
  | 'model_connection_profile_delete'

function handler(name: ProfileCommand): NodeHostCommandHandler {
  const route = createModelRoutes({ homeDir: context.home })[name]
  if (!route) throw new Error(`未注册的命令：${name}`)
  return route
}

function configPath(): string {
  return join(context.home, '.webAgent', 'config.json')
}

async function readConfig(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(configPath(), 'utf8')) as Record<string, any>
}

function saveInput(id: string, apiKey?: string) {
  return {
    input: {
      id,
      label: ` ${id} label `,
      baseUrl: ` https://${id}.example.com/v1/ `,
      models: [
        { id: ` ${id}-model `, label: ` ${id} model `, source: 'manual' },
        { id: `${id}-vision`, label: `${id} vision`, source: 'discovered' },
      ],
      ...(apiKey === undefined ? {} : { apiKey }),
    },
  }
}

describe('connection profile public CRUD', () => {
  it('keeps two profiles and credentials isolated without returning either key', async () => {
    const alphaKey = `${TEST_API_KEY}-alpha`
    const betaKey = `${TEST_API_KEY}-beta`

    const beta = await handler('model_connection_profile_save')(saveInput('beta', betaKey))
    const alpha = await handler('model_connection_profile_save')(saveInput('alpha', alphaKey))
    const listed = await handler('model_connection_profile_list')({})

    expect(alpha).toEqual({
      id: 'alpha',
      label: 'alpha label',
      kind: 'openai-compatible',
      baseUrl: 'https://alpha.example.com/v1',
      models: [
        { id: 'alpha-model', label: 'alpha model', source: 'manual' },
        { id: 'alpha-vision', label: 'alpha vision', source: 'discovered' },
      ],
      credentialConfigured: true,
    })
    expect((listed as Array<{ id: string }>).map(({ id }) => id)).toEqual(['alpha', 'beta'])
    expect(await handler('model_connection_profile_read')({ id: 'beta' })).toEqual(beta)
    expect(JSON.stringify({ alpha, beta, listed })).not.toContain(alphaKey)
    expect(JSON.stringify({ alpha, beta, listed })).not.toContain(betaKey)

    const config = await readConfig()
    expect(config.modelConnections.alpha).not.toHaveProperty('credentialConfigured')
    expect(config.modelConnections.beta).not.toHaveProperty('apiKey')
    expect(config.modelConnections.alpha.models.map(({ id }: { id: string }) => id))
      .toEqual(['alpha-model', 'alpha-vision'])
    expect(config.modelCredentials['openai-compat:profile:alpha']).toBe(alphaKey)
    expect(config.modelCredentials['openai-compat:profile:beta']).toBe(betaKey)
  })

  it('omitting apiKey on update preserves the existing credential', async () => {
    await handler('model_connection_profile_save')(saveInput('alpha', TEST_API_KEY))
    const updated = await handler('model_connection_profile_save')({
      input: {
        id: 'alpha',
        label: 'Renamed',
        baseUrl: 'https://new.example.com/v1',
        models: [{ id: 'new-model', label: 'New model', source: 'manual' }],
      },
    })

    expect(updated).toMatchObject({ label: 'Renamed', credentialConfigured: true })
    expect((await readConfig()).modelCredentials['openai-compat:profile:alpha']).toBe(TEST_API_KEY)
  })

  it('delete revokes only the selected key and makes its metadata unreachable', async () => {
    await handler('model_connection_profile_save')(saveInput('alpha', `${TEST_API_KEY}-alpha`))
    await handler('model_connection_profile_save')(saveInput('beta', `${TEST_API_KEY}-beta`))

    await expect(handler('model_connection_profile_delete')({ id: 'alpha' }))
      .resolves.toEqual({ deleted: true })
    await expect(handler('model_connection_profile_read')({ id: 'alpha' })).resolves.toBeNull()

    const config = await readConfig()
    expect(config.modelConnections.alpha).toBeUndefined()
    expect(config.modelCredentials['openai-compat:profile:alpha']).toBeUndefined()
    expect(config.modelCredentials['openai-compat:profile:beta']).toBe(`${TEST_API_KEY}-beta`)
  })

  it('delete also revokes an orphan key, while legacy openai-compat values remain untouched', async () => {
    await context.writeCredentials({
      'openai-compat:default': TEST_API_KEY,
      'openai-compat:default:baseUrl': 'https://legacy.example.com/v1',
      'openai-compat:profile:orphan': `${TEST_API_KEY}-orphan`,
    })

    await expect(handler('model_connection_profile_delete')({ id: 'orphan' }))
      .resolves.toEqual({ deleted: false })
    const credentials = (await readConfig()).modelCredentials
    expect(credentials['openai-compat:profile:orphan']).toBeUndefined()
    expect(credentials['openai-compat:default']).toBe(TEST_API_KEY)
    expect(credentials['openai-compat:default:baseUrl']).toBe('https://legacy.example.com/v1')
  })
})

describe('connection profile probe command', () => {
  it('narrows the request and does not write config or credentials', async () => {
    const before = await readFile(configPath(), 'utf8').catch(() => undefined)
    const fetchImpl = async () => new Response(JSON.stringify({ data: [{ id: 'model-a' }] }))
    const probe = createConnectionProfileProbeHandler({ fetchImpl })
    await expect(probe({
      input: { baseUrl: 'https://gateway.example.com/v1', apiKey: TEST_API_KEY },
    })).resolves.toEqual({
      models: [{ id: 'model-a', label: 'model-a', source: 'discovered' }],
    })
    expect(await readFile(configPath(), 'utf8').catch(() => undefined)).toBe(before)
  })

  it.each([
    {},
    { input: {} },
    { input: { baseUrl: 'https://gateway.example.com/v1', extra: true } },
    { input: { baseUrl: 42 } },
    { input: { baseUrl: 'https://gateway.example.com/v1', apiKey: 42 } },
  ])('rejects malformed command args', async (args) => {
    const fetchImpl = vi.fn()
    const probe = createConnectionProfileProbeHandler({ fetchImpl })
    await expect(probe(args as Record<string, unknown>))
      .rejects.toMatchObject({ reason: 'invalid-request' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
