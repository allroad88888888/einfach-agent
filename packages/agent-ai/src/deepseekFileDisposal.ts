import { DEEPSEEK_BASE_URL } from './deepseek'
import type { ChatCallOptions } from './modelApi'
import type { UserContentBlock, UserMessageContent } from './modelProtocol'
import { DEEPSEEK_FILE_SCOPE, isDeepSeekFileReference } from './deepseekMessages'

type ProviderFetch = NonNullable<ChatCallOptions['fetchImpl']>

export interface DeepSeekFileDisposalOptions {
  apiKey: string
  fetchImpl?: ProviderFetch
}

function deepSeekFileId(block: UserContentBlock): string | undefined {
  if (block.type !== 'image') return undefined
  const { source } = block
  if (source.kind !== 'provider-file'
    || source.provider !== 'deepseek'
    || source.scope !== DEEPSEEK_FILE_SCOPE
    || !isDeepSeekFileReference(source.reference)) return undefined
  return source.reference
}

function referencedDeepSeekFileIds(contents: readonly UserMessageContent[]): Set<string> {
  const ids = new Set<string>()
  for (const content of contents) {
    if (typeof content === 'string') continue
    for (const block of content) {
      const fileId = deepSeekFileId(block)
      if (fileId) ids.add(fileId)
    }
  }
  return ids
}

/** Best-effort deletion of discarded DeepSeek files that are no longer retained. */
export async function disposeDeepSeekProviderFiles(
  discarded: readonly UserMessageContent[],
  retained: readonly UserMessageContent[],
  options: DeepSeekFileDisposalOptions,
): Promise<void> {
  const discardedIds = referencedDeepSeekFileIds(discarded)
  const retainedIds = referencedDeepSeekFileIds(retained)
  const fetchImpl = options.fetchImpl ?? fetch
  const baseUrl = DEEPSEEK_BASE_URL.replace(/\/+$/, '')
  const deletions = [...discardedIds]
    .filter((fileId) => !retainedIds.has(fileId))
    .map((fileId) => Promise.resolve().then(() => fetchImpl(
      `${baseUrl}/files/${encodeURIComponent(fileId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${options.apiKey}` },
      },
    )))
  await Promise.allSettled(deletions)
}
