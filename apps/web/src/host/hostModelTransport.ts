// 选出当前宿主发模型请求用的 fetch 实现。
// ---------------------------------------------------------------------------
// API Key 不进入前端配置：桌面端走原生代理，开发浏览器走本地 Node 中继（Vite 插件
// `scripts/model-preview-relay`），其余一律拒绝模型请求。真实 Key 只由桌面原生层从
// `~/.webAgent/config.json` 读取，本层拿到的永远只是一个受管凭据标记。
//
// 【server 宿主此刻与 static 同待遇，是有意的】`apps/server` 今天没有模型端点——转发 provider
// 请求、流式响应、server 版凭据宿主是 M 线四张卡。在那之前给 server 宿主接任何一条模型通路都
// 意味着 Key 要经过这一侧，而这正是本文件开头那条纪律禁止的。所以这里按「有没有可信代理」
// 分流，而不是按宿主名分流：可信代理只有两条，桌面原生层与 dev 中继。
//
// 【为什么 DEV 判的是构建模式而不是宿主】dev 中继由 Vite 开发服务器提供，它在不在只取决于
// 这份产物是 `pnpm dev` 起的还是 `pnpm build` 出来的，与解析出的宿主是哪一态无关：
// `pnpm dev` 里 `/api/health` 404 → static 宿主 + 有中继；`pnpm serve` 托管的是构建产物
// → server 宿主 + 没有中继。两者正交，判据也就必须分开写。
import type { ResolvedHost } from './resolveHost'
import { createTauriModelFetch } from '../modelTransport/tauriModelTransport'
import { createDevPreviewModelFetch } from '../modelTransport/devPreviewModelTransport'
import { createUnavailableModelFetch } from '../modelTransport/unavailableModelTransport'

/** 造当前宿主唯一被允许的那条模型传输；没有可信代理时返回 fail-closed 的实现。 */
export function createHostModelFetch(host: ResolvedHost): typeof fetch {
  if (host.kind === 'tauri') return createTauriModelFetch()
  if (import.meta.env.DEV) return createDevPreviewModelFetch()
  return createUnavailableModelFetch()
}
