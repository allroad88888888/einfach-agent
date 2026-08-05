import type { UserContentBlock, UserMessageContent } from './modelProtocol'
import { KIMI_CN_BASE_URL } from './kimiRegion'

export interface KimiFileDisposalOptions {
  apiKey: string
  fetchImpl?: typeof fetch
}

const KIMI_CN_SCOPE = 'kimi:cn'
const KIMI_FILE_REFERENCE = /^ms:\/\/([A-Za-z0-9][A-Za-z0-9._-]{0,255})$/

function kimiFileId(block: UserContentBlock): string | undefined {
  if (block.type !== 'image') return undefined
  const { source } = block
  if (source.kind !== 'provider-file'
    || source.provider !== 'kimi'
    || source.scope !== KIMI_CN_SCOPE) return undefined
  return KIMI_FILE_REFERENCE.exec(source.reference)?.[1]
}

function referencedKimiFileIds(contents: readonly UserMessageContent[]): Set<string> {
  const ids = new Set<string>()
  for (const content of contents) {
    if (typeof content === 'string') continue
    for (const block of content) {
      const fileId = kimiFileId(block)
      if (fileId) ids.add(fileId)
    }
  }
  return ids
}

/**
 * Best-effort cleanup of discarded Kimi CN provider files.
 *
 * The adapter alone understands `ms://` references. Retained references win, so a
 * file still reachable from another message is never deleted by this operation.
 */
export async function disposeKimiUserContent(
  discarded: readonly UserMessageContent[],
  retained: readonly UserMessageContent[],
  options: KimiFileDisposalOptions,
): Promise<void> {
  const discardedIds = referencedKimiFileIds(discarded)
  const retainedIds = referencedKimiFileIds(retained)
  const fetchImpl = options.fetchImpl ?? fetch
  const deletions = [...discardedIds]
    .filter((fileId) => !retainedIds.has(fileId))
    .map((fileId) => Promise.resolve().then(() => fetchImpl(
      `${KIMI_CN_BASE_URL}/files/${encodeURIComponent(fileId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${options.apiKey}` },
      },
    )))
  await Promise.allSettled(deletions)
}
