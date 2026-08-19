// 按当前宿主装上「页面要没了，先把恢复写队列排空」的生命周期钩子。
// ---------------------------------------------------------------------------
// 浏览器的 `pagehide` 不给任何等待机会，只能尽力把已有写队列冲出去。两态（server / static）都跑
// 在浏览器里，所以都只有这一条通路。
//
// 【T1 删掉了什么】桌面端曾有一条可 await 的关窗拦截（先 preventDefault、排空后再 destroy），
// 判据就是宿主态本身。桌面端退出后这个函数只剩一支——它仍保留 `host` 形参与 async 签名，
// 因为它是 `main.tsx` 装配序列里「按宿主分流的五个装配面」之一，签名统一比省一个参数值钱：
// 将来任何一种给得出「关闭前还能 await 一次」的宿主回来，改的是这里，不是调用点。
import type { CoreInstance } from '@einfach-agent/core'
import type { ResolvedHost } from './resolveHost'
import { installBrowserRecoveryFlush } from '../persistence/recoveryFlushLifecycle'

/** 装上当前宿主能提供的那种刷盘时机；两态都只有浏览器那条。 */
export async function installHostRecoveryFlush(_host: ResolvedHost, core: CoreInstance): Promise<void> {
  installBrowserRecoveryFlush(core)
}
