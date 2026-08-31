import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConnectionProfileSaveHandler } from './connectionProfileCommands'
import { writeModelCredentialKey } from './credentialSection'
import { forwardProviderRequest } from './forwardRequest'
import { useModelTestContext } from './modelTestContext.testHarness'
import { writeRegisteredOpenAiCompatOrigin } from './openAiCompatEndpoint'
import { collect } from './upstreamServer.testHarness'

const snapshotGate = vi.hoisted(() => ({
  afterNextRead: undefined as (() => Promise<void>) | undefined,
}))

vi.mock('../config/webAgentConfigStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('../config/webAgentConfigStore')>()
  return {
    ...original,
    createWebAgentConfigStore(...args: Parameters<typeof original.createWebAgentConfigStore>) {
      const store = original.createWebAgentConfigStore(...args)
      return {
        ...store,
        async readSections(sections: readonly string[]) {
          const snapshot = await store.readSections(sections)
          const afterRead = snapshotGate.afterNextRead
          snapshotGate.afterNextRead = undefined
          if (afterRead !== undefined) await afterRead()
          return snapshot
        },
      }
    },
  }
})

const context = useModelTestContext()

function profileEnvelope(id: string, requestId: string) {
  return {
    target: {
      provider: 'openai-compat', scope: 'default', method: 'POST',
      path: '/chat/completions', connectionId: id,
    },
    body: { kind: 'json', json: '{}' },
    requestId,
  }
}

function legacyEnvelope(requestId: string) {
  return {
    target: {
      provider: 'openai-compat', scope: 'default', method: 'POST',
      path: '/chat/completions',
    },
    body: { kind: 'json', json: '{}' },
    requestId,
  }
}

async function saveProfile(baseUrl: string, apiKey: string): Promise<void> {
  await createConnectionProfileSaveHandler({ homeDir: context.home })({
    input: {
      id: 'racing', label: 'Racing profile', baseUrl,
      models: [{ id: 'racing-model', label: 'Racing model', source: 'manual' }], apiKey,
    },
  })
}

afterEach(() => {
  snapshotGate.afterNextRead = undefined
})

describe('connection profile forward binding snapshot', () => {
  it('never mixes an old origin with a concurrently saved new key', async () => {
    const oldOrigin = 'https://old.example.com/v1'
    const newOrigin = 'https://new.example.com/v1'
    await saveProfile(oldOrigin, 'old-secret')
    snapshotGate.afterNextRead = () => saveProfile(newOrigin, 'new-secret')
    const fake = await context.upstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
    })

    const response = await forwardProviderRequest(
      profileEnvelope('racing', 'atomic-binding'), context.deps(fake),
    )
    await collect(response.body)

    const observed = [fake.calls[0]?.url, fake.received[0]?.headers.authorization]
    expect([
      [`${oldOrigin}/chat/completions`, 'Bearer old-secret'],
      [`${newOrigin}/chat/completions`, 'Bearer new-secret'],
    ]).toContainEqual(observed)
    expect(JSON.parse(await readFile(
      join(context.home, '.webAgent', 'config.json'), 'utf8',
    ))).toMatchObject({
      modelConnections: { racing: { baseUrl: newOrigin } },
      modelCredentials: { 'openai-compat:profile:racing': 'new-secret' },
    })
  })

  it('fails malformed profile sections before upstream fetch', async () => {
    const configPath = join(context.home, '.webAgent', 'config.json')
    const fake = await context.upstream((_request, response) => response.end())
    for (const sections of [
      { modelConnections: [], modelCredentials: {} },
      {
        modelConnections: {
          racing: {
            id: 'racing', label: 'Racing profile', kind: 'openai-compatible',
            baseUrl: 'https://valid.example.com/v1', model: 'racing-model',
          },
        },
        modelCredentials: { 'openai-compat:profile:racing': 7 },
      },
    ]) {
      await writeFile(configPath, JSON.stringify({ version: 1, ...sections }))
      await expect(forwardProviderRequest(
        profileEnvelope('racing', `bad-section-${fake.calls.length}`), context.deps(fake),
      )).rejects.toMatchObject({ reason: 'credential-config-invalid' })
    }
    expect(fake.calls).toHaveLength(0)
  })

  it('preserves the legacy no-ID endpoint and credential binding', async () => {
    const legacyOrigin = 'https://legacy.example.com/v1'
    await writeRegisteredOpenAiCompatOrigin({ homeDir: context.home }, legacyOrigin)
    await writeModelCredentialKey(
      { homeDir: context.home }, 'openai-compat:default', 'legacy-secret',
    )
    const fake = await context.upstream((_request, response) => response.end('{}'))

    const response = await forwardProviderRequest(
      legacyEnvelope('legacy-binding'), context.deps(fake),
    )
    await collect(response.body)

    expect(fake.calls[0]?.url).toBe(`${legacyOrigin}/chat/completions`)
    expect(fake.received[0]?.headers.authorization).toBe('Bearer legacy-secret')
  })
})
