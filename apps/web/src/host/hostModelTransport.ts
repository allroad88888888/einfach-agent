// 选出当前宿主发模型请求用的 fetch 实现。
// ---------------------------------------------------------------------------
// API Key 不进入前端配置：server 宿主走 `apps/server` 的流式模型端点（`POST /api/model/request`），
// 开发浏览器走本地 Node 中继（Vite 插件 `scripts/model-preview-relay`），其余一律拒绝模型请求。
// 真实 Key 只由**本机 Node 后端**从 `~/.webAgent/config.json` 读取，本层拿到的永远只是一个受管
// 凭据标记。
//
// 【T1 删掉了什么】曾有第三条可信代理：桌面原生层。桌面端退出后只剩上面两条。
//
// 【为什么 server 必须排在 DEV 之前】`createHostModelCredentialHost` 是
// `server → unavailable`，**没有 DEV 分支**。若这里让 DEV 赢，一个「`pnpm dev` 前端 +
// 真 apps/server 后端」的混合会话会走成：Key 经 `/api/invoke/model_credential_set` 存进后端的
// 配置文件，请求却发给只认 `DEEPSEEK_API_KEY` 等环境变量的 Vite 中继（`vite.config.ts`）——
// 存进去了但发不出去，而两边都不报错。凭据宿主与传输必须由**同一个判据**选出来。
//
// 【为什么 DEV 判的是构建模式而不是宿主】dev 中继由 Vite 开发服务器提供，它在不在只取决于
// 这份产物是 `pnpm dev` 起的还是 `pnpm build` 出来的，与解析出的宿主是哪一态无关：
// `pnpm dev` 里 `/api/health` 404 → static 宿主 + 有中继；`pnpm serve` 托管的是构建产物
// → server 宿主 + 没有中继。两者正交，判据也就必须分开写。
import type { ResolvedHost } from './resolveHost'
import { createServerModelFetch } from '../modelTransport/serverModelTransport'
import { createDevPreviewModelFetch } from '../modelTransport/devPreviewModelTransport'
import { createUnavailableModelFetch } from '../modelTransport/unavailableModelTransport'

/** 造当前宿主唯一被允许的那条模型传输；没有可信代理时返回 fail-closed 的实现。 */
export function createHostModelFetch(host: ResolvedHost): typeof fetch {
  if (host.kind === 'server') return createServerModelFetch()
  if (import.meta.env.DEV) return createDevPreviewModelFetch()
  return createUnavailableModelFetch()
}
