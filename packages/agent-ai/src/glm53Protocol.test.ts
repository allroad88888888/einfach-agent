import { describe, expect, it } from 'vitest'
import { callModel } from './modelAdapter'

const GLM_MODELS = ['glm-5.3', 'glm-5.3-flash'] as const

function response(): Response {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

async function captureBody(
  model: typeof GLM_MODELS[number],
  thinking: unknown,
  reasoningEffort?: unknown,
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | undefined
  const request = {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    ...(thinking === undefined ? {} : { thinking }),
    settings: {
      vendor: 'glm',
      ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
    },
  } as unknown as Parameters<typeof callModel>[0]
  await callModel(
    request,
    {
      apiKey: 'test-key',
      retry: { maxRetries: 0 },
      fetchImpl: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return response()
      },
    },
  )
  if (body === undefined) throw new Error('Expected a fetch request.')
  return body
}

describe('GLM-5.3 request protocol', () => {
  it.each(GLM_MODELS)('%s forces Thinking enabled for dirty session state', async (model) => {
    for (const thinking of [undefined, { type: 'disabled' }, { type: 'invalid' }, false]) {
      const body = await captureBody(model, thinking, 'high')

      expect(body).toMatchObject({
        model,
        thinking: { type: 'enabled' },
        reasoning_effort: 'high',
      })
    }
  })

  it.each(GLM_MODELS)('%s sends only low, high, or max effort', async (model) => {
    for (const effort of ['low', 'high', 'max'] as const) {
      expect(await captureBody(model, { type: 'enabled' }, effort)).toHaveProperty(
        'reasoning_effort',
        effort,
      )
    }

    for (const effort of ['medium', 'xhigh', 'minimal', 'none', 'dirty']) {
      const body = await captureBody(model, { type: 'disabled' }, effort)
      expect(body).toHaveProperty('thinking', { type: 'enabled' })
      expect(body).not.toHaveProperty('reasoning_effort')
    }
  })

  it.each(GLM_MODELS)('%s represents Auto by omitting effort', async (model) => {
    const body = await captureBody(model, { type: 'disabled' })

    expect(body).toHaveProperty('thinking', { type: 'enabled' })
    expect(body).not.toHaveProperty('reasoning_effort')
  })
})
