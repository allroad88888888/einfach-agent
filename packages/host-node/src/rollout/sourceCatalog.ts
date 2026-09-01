import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const HASH = /^[a-f0-9]{64}$/

export interface CanonicalRolloutSource {
  readonly filePath: string
  readonly historyId: string
}

function sourceAt(root: string, filePath: string): CanonicalRolloutSource | undefined {
  const parts = relative(root, filePath).split(sep)
  if (parts.length === 3 && parts[0] === 'conversations' && HASH.test(parts[1]) && parts[2] === 'root.jsonl') {
    return { filePath, historyId: `root:${parts[1]}` }
  }
  if (parts.length === 6 && parts[0] === 'conversations' && HASH.test(parts[1]) && parts[2] === 'runs'
    && HASH.test(parts[3]) && parts[4] === 'agents' && /^[a-f0-9]{64}\.jsonl$/.test(parts[5])) {
    return { filePath, historyId: `child:${parts[1]}:${parts[3]}:${parts[5].slice(0, -6)}` }
  }
  return undefined
}

/** Lists only canonical rollout histories below one application-data directory. */
export async function discoverCanonicalRolloutSources(appDataDirectory: string): Promise<readonly CanonicalRolloutSource[]> {
  const root = join(appDataDirectory, 'rollouts')
  const sources: CanonicalRolloutSource[] = []
  async function visit(directory: string): Promise<void> {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const filePath = join(directory, entry.name)
      if (entry.isDirectory()) await visit(filePath)
      else if (entry.isFile()) {
        const source = sourceAt(root, filePath)
        if (source) sources.push(source)
      }
    }
  }
  await visit(join(root, 'conversations'))
  return sources.sort((left, right) => left.filePath.localeCompare(right.filePath))
}
