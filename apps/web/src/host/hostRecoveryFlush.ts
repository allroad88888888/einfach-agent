// 按当前宿主装上「页面/窗口要没了，先把恢复写队列排空」的生命周期钩子。
// ---------------------------------------------------------------------------
// 桌面关窗有 Tauri 的可 await 拦截（先 preventDefault，排空后再 destroy）；浏览器 pagehide
// 不给任何等待机会，只能尽力把已有写队列冲出去。两条通路的差别不在实现细节而在宿主给不给
// 「关闭前还能 await 一次」这个能力，所以判据就是宿主态本身。
//
// 两边都只持有传进来的这个 Core instance，绝不触默认 facade 的持久化桥。
import type { CoreInstance } from '@einfach-agent/core'
import type { ResolvedHost } from './resolveHost'
import {
  installBrowserRecoveryFlush,
  installDesktopRecoveryFlush,
} from '../persistence/recoveryFlushLifecycle'

/** 装上当前宿主能提供的那种刷盘时机；server 与 static 都只有浏览器那条。 */
export async function installHostRecoveryFlush(host: ResolvedHost, core: CoreInstance): Promise<void> {
  if (host.kind === 'tauri') {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await installDesktopRecoveryFlush(core, getCurrentWindow())
    return
  }
  installBrowserRecoveryFlush(core)
}
