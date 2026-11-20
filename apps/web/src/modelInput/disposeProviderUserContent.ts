import {
  disposeDeepSeekProviderFiles,
  disposeKimiUserContent,
  type ModelAdapterSettings,
  type UserMessageContent,
} from '@einfach-agent/ai'

export interface ProviderContentDisposalDependencies {
  apiKey?: string
  modelCredentials?: Readonly<Record<string, string | undefined>>
  fetchImpl: typeof fetch
}

export interface ProviderContentDisposalContext {
  settings: Readonly<ModelAdapterSettings>
}

/** Host dispatch only: reference parsing and deletion stay inside the provider adapter. */
export async function disposeProviderUserContent(
  discarded: readonly UserMessageContent[],
  retained: readonly UserMessageContent[],
  _context: ProviderContentDisposalContext,
  dependencies: ProviderContentDisposalDependencies,
): Promise<void> {
  // Dispatch by asking each registered adapter to inspect its own opaque source.
  // The session may have switched models since the content was uploaded, so its
  // current settings must not decide which provider owns the old reference.
  const kimiApiKey = (dependencies.modelCredentials?.kimi ?? dependencies.apiKey ?? '').trim()
  const deepSeekApiKey = (dependencies.modelCredentials?.deepseek ?? dependencies.apiKey ?? '').trim()
  await Promise.all([
    kimiApiKey
      ? disposeKimiUserContent(discarded, retained, {
          apiKey: kimiApiKey,
          fetchImpl: dependencies.fetchImpl,
        })
      : Promise.resolve(),
    deepSeekApiKey
      ? disposeDeepSeekProviderFiles(discarded, retained, {
          apiKey: deepSeekApiKey,
          fetchImpl: dependencies.fetchImpl,
        })
      : Promise.resolve(),
  ])
}
