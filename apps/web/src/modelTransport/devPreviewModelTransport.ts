import type { ProviderTransport, ProviderTransportInput } from '@einfach-agent/ai'
import { createProviderFetch } from './providerFetch'
import { encodeProviderWireRequest } from './providerWireEnvelope'

export const MODEL_PREVIEW_RELAY_PATH = '/__web_agent_model_preview'

/** Creates the typed development transport backed by the loopback-only Vite relay. */
export function createDevPreviewProviderTransport(): ProviderTransport {
  return {
    async request(input: ProviderTransportInput): Promise<Response> {
      const request = await encodeProviderWireRequest(input)
      return fetch(MODEL_PREVIEW_RELAY_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: input.signal,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
      })
    },
  }
}

/** Preserves the existing fetch injection API for current model adapters. */
export function createDevPreviewModelFetch(): typeof fetch {
  return createProviderFetch(createDevPreviewProviderTransport())
}
