import type { HistoryLogBatch, HistoryLogDriver } from '@einfach-agent/core/state/persistence'
import type { NodeHostRouteTable } from '../routeTable'

declare module '../commandArgs' {
  interface NodeHostCommandArgs {
    session_history_append: { sessionId: string; batch: HistoryLogBatch }
    session_history_load: { sessionId: string; head: string | null }
  }
}

function session(args: Record<string, unknown>): string {
  if (typeof args.sessionId !== 'string' || !args.sessionId) throw new Error('Invalid history sessionId')
  return args.sessionId
}

export function createHistoryLogRoutes(driver: HistoryLogDriver): NodeHostRouteTable {
  return {
    async session_history_append(args) {
      await driver.append(session(args), args.batch as HistoryLogBatch)
      return null
    },
    async session_history_load(args) {
      if (args.head !== null && (typeof args.head !== 'string' || !args.head || args.head.length > 128)) {
        throw new Error('Invalid history journal head')
      }
      return driver.load(session(args), args.head as string | null)
    },
  }
}
