const LEGACY_OPENAI_COMPAT_IDENTITY = Symbol('legacy-openai-compat-identity')

type LegacyOpenAiCompatMarked = {
  [LEGACY_OPENAI_COMPAT_IDENTITY]?: true
}

export interface ProviderLocalRequestIdentity {
  readonly connectionId?: string
  readonly legacyOpenAiCompat?: true
}

type ProviderLocalFetchHandler = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  identity: ProviderLocalRequestIdentity | undefined,
) => Promise<Response>

const closedProviderFetches = new WeakSet<object>()
const requestIdentities = new WeakMap<RequestInit, ProviderLocalRequestIdentity>()

/** Marks options inside the adapter package without exposing a caller-selectable identity field. */
export function markLegacyOpenAiCompat<T extends object>(options: T): T {
  return { ...options, [LEGACY_OPENAI_COMPAT_IDENTITY]: true }
}

export function isLegacyOpenAiCompat(options: object): boolean {
  return (options as LegacyOpenAiCompatMarked)[LEGACY_OPENAI_COMPAT_IDENTITY] === true
}

/** Creates the only fetch shape allowed to receive local provider-routing identity. */
export function createProviderTransportFetch(handler: ProviderLocalFetchHandler): typeof fetch {
  const fetchImpl: typeof fetch = async (input, init) => {
    return handler(input, init, init === undefined ? undefined : requestIdentities.get(init))
  }
  closedProviderFetches.add(fetchImpl)
  return fetchImpl
}

/** Associates identity in memory only; plain/global fetch implementations are intentionally ignored. */
export function associateProviderLocalIdentity(
  fetchImpl: typeof fetch | undefined,
  init: RequestInit,
  identity: ProviderLocalRequestIdentity,
): void {
  if (fetchImpl === undefined || !closedProviderFetches.has(fetchImpl)) return
  if (identity.connectionId === undefined && identity.legacyOpenAiCompat !== true) return
  requestIdentities.set(init, Object.freeze({ ...identity }))
}
