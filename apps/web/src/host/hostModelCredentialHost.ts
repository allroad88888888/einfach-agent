// 选出当前宿主保存模型 API Key 的通路。
// ---------------------------------------------------------------------------
// server 宿主把 Key 经 `/api/invoke/model_credential_*` 交给本机 Node 后端，由后端写进
// `~/.webAgent/config.json`；三条命令的返回体只有 `{ configured, source }`，不会回传 Key。
//
// 静态构建是明确的 BYOK 例外：用户主动在设置页输入的 Key 落浏览器 localStorage，并由浏览器直连
// 官方 provider。开发预览继续使用不接触浏览器 Key 的本地 relay，方便使用非 VITE 的开发环境变量。
//
// 【T1 删掉了什么】曾有第三态 `tauri`，Key 由桌面原生层读写同一份配置文件。桌面端退出后
// 本机 Node 后端是唯一的宿主通路。
import type { ResolvedHost } from './resolveHost'
import { createServerModelCredentialHost } from '../settings/serverModelCredentialHost'
import { createBrowserModelCredentialHost } from '../settings/browserModelCredentialHost'
import {
  createUnavailableModelCredentialHost,
  type ModelCredentialHost,
} from '../settings/modelCredentialHost'

/** 造当前宿主的凭据宿主；`available` 同时也是启动凭据门禁开不开的判据。 */
export function createHostModelCredentialHost(host: ResolvedHost): ModelCredentialHost {
  if (host.kind === 'server') return createServerModelCredentialHost()
  if (!import.meta.env.DEV) return createBrowserModelCredentialHost()
  return createUnavailableModelCredentialHost()
}
