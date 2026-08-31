import { describe, expect, it } from 'vitest'
import {
  createConnectionProfileDeleteHandler,
  createConnectionProfileSaveHandler,
} from './connectionProfileCommands'
import { connectionProfileCredentialKey } from './connectionProfile'
import { deleteModelCredentialKey } from './credentialSection'
import { forwardProviderRequest } from './forwardRequest'
import { useModelTestContext } from './modelTestContext.testHarness'
import { collect } from './upstreamServer.testHarness'

const context = useModelTestContext()
const SHARED_URL = 'https://shared.example.com/v1'

async function saveProfile(id: string, apiKey: string, baseUrl = SHARED_URL): Promise<void> {
  await createConnectionProfileSaveHandler({ homeDir: context.home })({
    input: {
      id, label: id, baseUrl,
      models: [{ id: `${id}-model`, label: `${id} model`, source: 'manual' }],
      apiKey,
    },
  })
}

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

describe('profile-selected provider forwarding', () => {
  it('isolates shared-URL profiles and selects each server-side profile key', async () => {
    await saveProfile('alpha', 'alpha-secret')
    await saveProfile('beta', 'beta-secret')
    const fake = await context.upstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
    })

    const alpha = await forwardProviderRequest(
      profileEnvelope('alpha', 'profile-alpha'), context.deps(fake),
    )
    await collect(alpha.body)
    const beta = await forwardProviderRequest(
      profileEnvelope('beta', 'profile-beta'), context.deps(fake),
    )
    await collect(beta.body)

    expect(fake.calls.map((call) => call.url)).toEqual([
      `${SHARED_URL}/chat/completions`, `${SHARED_URL}/chat/completions`,
    ])
    expect(fake.received.map((request) => request.headers.authorization)).toEqual([
      'Bearer alpha-secret', 'Bearer beta-secret',
    ])
    expect(fake.received.every(
      (request) => request.headers['x-web-agent-connection-id'] === undefined,
    )).toBe(true)
  })

  it('unknown and deleted IDs fail before any upstream fetch', async () => {
    await saveProfile('deleted', 'deleted-secret')
    await createConnectionProfileDeleteHandler({ homeDir: context.home })({ id: 'deleted' })
    const fake = await context.upstream((_request, response) => response.end())

    await expect(forwardProviderRequest(
      profileEnvelope('unknown', 'unknown-profile'), context.deps(fake),
    )).rejects.toThrow('模型请求目标未获允许')
    await expect(forwardProviderRequest(
      profileEnvelope('deleted', 'deleted-profile'), context.deps(fake),
    )).rejects.toThrow('模型请求目标未获允许')
    expect(fake.calls).toHaveLength(0)
  })

  it('a stored profile with a missing key fails before upstream fetch', async () => {
    await saveProfile('keyless', 'temporary-secret')
    await deleteModelCredentialKey(
      { homeDir: context.home }, connectionProfileCredentialKey('keyless'),
    )
    const fake = await context.upstream((_request, response) => response.end())

    await expect(forwardProviderRequest(
      profileEnvelope('keyless', 'keyless-profile'), context.deps(fake),
    )).rejects.toThrow('未配置 OpenAI 兼容端点 API Key')
    expect(fake.calls).toHaveLength(0)
  })
})
