import {
  OPENAI_COMPAT_VENDOR_ID,
  createOpenAiCompatAdapter,
  defaultProviderRegistry,
} from '@einfach-agent/ai'

export interface PublicOpenAiCompatConnection {
  readonly id: string
  readonly kind: 'openai-compatible'
  readonly baseUrl: string
}

let legacyOrigin: string | undefined
let connections = new Map<string, PublicOpenAiCompatConnection>()

function registerAdapter(): void {
  defaultProviderRegistry.register(OPENAI_COMPAT_VENDOR_ID, createOpenAiCompatAdapter({
    baseUrl: legacyOrigin,
    connectionBaseUrl: (id) => connections.get(id)?.baseUrl,
  }))
}

export function openAiCompatLegacyOrigin(): string | undefined {
  return legacyOrigin
}

export function setOpenAiCompatLegacyOrigin(baseUrl: string | undefined): void {
  legacyOrigin = baseUrl
  registerAdapter()
}

export function openAiCompatConnection(
  id: string,
): PublicOpenAiCompatConnection | undefined {
  return connections.get(id)
}

/** Replaces the complete hydrated public registry; secrets are not part of this shape. */
export function replaceOpenAiCompatConnections(
  profiles: readonly PublicOpenAiCompatConnection[],
): void {
  connections = new Map(profiles.map((profile) => [profile.id, {
    id: profile.id,
    kind: profile.kind,
    baseUrl: profile.baseUrl,
  }]))
  registerAdapter()
}
