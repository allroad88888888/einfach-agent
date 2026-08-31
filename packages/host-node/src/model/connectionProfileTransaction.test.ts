import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createModelRoutes } from './index'
import { TEST_API_KEY, useModelTestContext } from './modelTestContext.testHarness'
import type { NodeHostCommandHandler } from '../routeTable'

const atomicWriteFault = vi.hoisted(() => ({ failNext: 0, writeCalls: 0 }))

vi.mock('../config/restrictedWrite', async (importOriginal) => {
  const original = await importOriginal<typeof import('../config/restrictedWrite')>()
  return {
    ...original,
    async writeRestrictedAtomically(path: string, contents: string) {
      atomicWriteFault.writeCalls += 1
      if (atomicWriteFault.failNext > 0) {
        atomicWriteFault.failNext -= 1
        throw new Error('simulated atomic write failure')
      }
      return original.writeRestrictedAtomically(path, contents)
    },
  }
})

const context = useModelTestContext()

type ProfileCommand =
  | 'model_connection_profile_save'
  | 'model_connection_profile_delete'
  | 'model_connection_profile_read'

function handler(name: ProfileCommand): NodeHostCommandHandler {
  const route = createModelRoutes({ homeDir: context.home })[name]
  if (!route) throw new Error(`未注册的命令：${name}`)
  return route
}

function configPath(): string {
  return join(context.home, '.webAgent', 'config.json')
}

function saveInput(
  id: string,
  apiKey: string | undefined,
  endpoint = `https://${id}.example.com/v1`,
) {
  return {
    input: {
      id,
      label: `${id} gateway`,
      baseUrl: endpoint,
      models: [
        { id: `${id}-model`, label: `${id} model`, source: 'manual' },
        { id: `${id}-vision`, label: `${id} vision`, source: 'discovered' },
      ],
      ...(apiKey === undefined ? {} : { apiKey }),
    },
  }
}

async function bytes(): Promise<string> {
  return readFile(configPath(), 'utf8')
}

async function config(): Promise<Record<string, any>> {
  return JSON.parse(await bytes()) as Record<string, any>
}

afterEach(() => {
  atomicWriteFault.failNext = 0
  atomicWriteFault.writeCalls = 0
})

describe('connection profile atomic persistence', () => {
  it('uses exactly one atomic write for each successful save, update, and delete', async () => {
    const before = atomicWriteFault.writeCalls
    await handler('model_connection_profile_save')(saveInput('alpha', `${TEST_API_KEY}-old`))
    expect(atomicWriteFault.writeCalls).toBe(before + 1)

    await handler('model_connection_profile_save')(
      saveInput('alpha', `${TEST_API_KEY}-new`, 'https://new.example.com/v1'),
    )
    expect(atomicWriteFault.writeCalls).toBe(before + 2)

    await handler('model_connection_profile_delete')({ id: 'alpha' })
    expect(atomicWriteFault.writeCalls).toBe(before + 3)
  })

  it('failed new save leaves neither metadata nor an orphan credential', async () => {
    const before = await bytes()
    atomicWriteFault.failNext = 1

    await expect(handler('model_connection_profile_save')(
      saveInput('new-profile', `${TEST_API_KEY}-new`),
    )).rejects.toThrow('simulated atomic write failure')

    await expect(bytes()).resolves.toBe(before)
    const persisted = await config()
    expect(persisted.modelConnections?.['new-profile']).toBeUndefined()
    expect(persisted.modelCredentials['openai-compat:profile:new-profile']).toBeUndefined()
  })

  it('failed endpoint plus supplied-key update keeps the old matching pair byte-for-byte', async () => {
    await handler('model_connection_profile_save')(
      saveInput('alpha', `${TEST_API_KEY}-old`, 'https://old.example.com/v1'),
    )
    const before = await bytes()
    atomicWriteFault.failNext = 1

    await expect(handler('model_connection_profile_save')(
      saveInput('alpha', `${TEST_API_KEY}-new`, 'https://new.example.com/v1'),
    )).rejects.toThrow('simulated atomic write failure')

    await expect(bytes()).resolves.toBe(before)
    const persisted = await config()
    expect(persisted.modelConnections.alpha.baseUrl).toBe('https://old.example.com/v1')
    expect(persisted.modelCredentials['openai-compat:profile:alpha']).toBe(`${TEST_API_KEY}-old`)
  })

  it('failed delete cannot leave metadata and credential half-deleted', async () => {
    await handler('model_connection_profile_save')(saveInput('alpha', `${TEST_API_KEY}-alpha`))
    const before = await bytes()
    atomicWriteFault.failNext = 1

    await expect(handler('model_connection_profile_delete')({ id: 'alpha' }))
      .rejects.toThrow('simulated atomic write failure')

    await expect(bytes()).resolves.toBe(before)
    expect(await handler('model_connection_profile_read')({ id: 'alpha' })).toMatchObject({
      id: 'alpha',
      credentialConfigured: true,
    })
  })

  it('failed key-omitting update preserves the existing credential and metadata', async () => {
    await handler('model_connection_profile_save')(saveInput('alpha', `${TEST_API_KEY}-alpha`))
    const before = await bytes()
    atomicWriteFault.failNext = 1

    await expect(handler('model_connection_profile_save')(
      saveInput('alpha', undefined, 'https://renamed.example.com/v1'),
    )).rejects.toThrow('simulated atomic write failure')

    await expect(bytes()).resolves.toBe(before)
    expect((await config()).modelCredentials['openai-compat:profile:alpha'])
      .toBe(`${TEST_API_KEY}-alpha`)
  })

  it('key-omitting update rejects credential-less metadata before any write', async () => {
    await writeFile(configPath(), JSON.stringify({
      version: 1,
      modelConnections: {
        alpha: {
          id: 'alpha',
          label: 'old gateway',
          kind: 'openai-compatible',
          baseUrl: 'https://old.example.com/v1',
          model: 'old-model',
        },
      },
      modelCredentials: { 'deepseek:default': TEST_API_KEY },
    }))
    const before = await bytes()
    const writesBefore = atomicWriteFault.writeCalls

    await expect(handler('model_connection_profile_save')(
      saveInput('alpha', undefined, 'https://new.example.com/v1'),
    )).rejects.toMatchObject({ reason: 'credential-missing' })

    await expect(bytes()).resolves.toBe(before)
    expect(atomicWriteFault.writeCalls).toBe(writesBefore)
  })

  it('preflights both sections before writing either one', async () => {
    const malformed = [
      { modelConnections: [], modelCredentials: {} },
      { modelConnections: {}, modelCredentials: { broken: 7 } },
    ]

    for (const sections of malformed) {
      await writeFile(configPath(), JSON.stringify({ version: 1, ...sections }))
      const before = await bytes()
      const writesBefore = atomicWriteFault.writeCalls
      await expect(handler('model_connection_profile_save')(
        saveInput('alpha', `${TEST_API_KEY}-alpha`),
      )).rejects.toMatchObject({ reason: 'credential-config-invalid' })
      await expect(bytes()).resolves.toBe(before)
      expect(atomicWriteFault.writeCalls).toBe(writesBefore)
    }
  })

  it('serializes concurrent profile transactions without losing profiles or keys', async () => {
    const ids = Array.from({ length: 10 }, (_, index) => `profile-${index}`)
    await Promise.all(ids.map((id) => handler('model_connection_profile_save')(
      saveInput(id, `${TEST_API_KEY}-${id}`),
    )))

    const persisted = await config()
    for (const id of ids) {
      expect(persisted.modelConnections[id].id).toBe(id)
      expect(persisted.modelCredentials[`openai-compat:profile:${id}`]).toBe(`${TEST_API_KEY}-${id}`)
    }
  })
})
