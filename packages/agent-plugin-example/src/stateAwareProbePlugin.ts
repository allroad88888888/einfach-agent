// 会话状态读写面（F2b，`ctx.state`）的可运行样例：读会话状态、写一笔，并把「被门挡下」当正常
// 分支处理，而不是当异常。

import { definePlugin, type Plugin } from '@einfach-agent/core/plugin'

export interface StateAwareProbePluginOptions {
  /**
   * Reports the outcome of each write attempt: the new item id, or `undefined` when the write
   * was gated (ghost session / stale run / aborted). A gated write is not an error — it just
   * means the run this plugin was writing on is no longer the one in front of the user.
   */
  readonly onWriteOutcome?: (id: string | undefined) => void
}

/**
 * Creates a plugin that demonstrates the F2b state read/write facade exposed on
 * `PluginHookContext.state`.
 *
 * On every `onTurnEnd` it reads the session's current item count via `readSession('items')` and
 * appends a system note recording it via `appendItem`. This is the recommended shape to copy:
 *
 * - The write is guarded (ghost session / stale run / abort) and the guard is evaluated **at
 *   call time**, so callers never need to call `ctx.isCurrent()` first — not even after an
 *   `await` between the read and the write.
 * - The one thing a caller must do is check the return value. `appendItem` returns `undefined`
 *   when the write was gated; that is a normal outcome to branch on, not something to throw
 *   over (see `packages/agent-core/src/runtime/core/pluginStateContracts.ts` for why the facade
 *   is shaped this way).
 */
export function createStateAwareProbePlugin(
  options: StateAwareProbePluginOptions = {},
): Plugin {
  return definePlugin({
    activate(api) {
      api.hook('onTurnEnd', (ctx) => {
        const items = ctx.state.readSession('items')
        const id = ctx.state.appendItem({
          role: 'system',
          content: `state-aware-probe: turn ended with ${items.length} item(s) in the session.`,
        })
        // Do not assume the append landed just because execution got this far — check `id`.
        options.onWriteOutcome?.(id)
      })
    },
  })
}
