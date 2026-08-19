// 选出当前宿主保存模型 API Key 的通路。
// ---------------------------------------------------------------------------
// 只有桌面原生层能读写 `~/.webAgent/config.json`，也只有它的 IPC 响应保证不回传 Key 本身。
// 其余宿主拿到的是那个如实回答「模型密钥只能在桌面应用配置文件中保存」的实现——它的
// `available` 为 false，设置面板据此把输入框整块收起来，而不是给出一个存不进去的框。
//
// 【server 宿主走 M4 的实现，不再与 static 同】Key 仍然只由**宿主**读写：浏览器把它经
// `/api/invoke/model_credential_*` 交给本机 Node 后端，由后端写进 `~/.webAgent/config.json`，
// 三条命令的返回体只有 `{ configured, source }`、**任何路径都不回传 Key 本身**（M4 有正面用例
// 钉死）。所以「真实 Key 不由前端保管」这条纪律没有松动——变的只是「宿主」不再只有桌面原生层。
// static 宿主仍然 unavailable：它背后压根没有能写文件的机器。
import type { ResolvedHost } from './resolveHost'
import { createServerModelCredentialHost } from '../settings/serverModelCredentialHost'
import {
  createTauriModelCredentialHost,
  createUnavailableModelCredentialHost,
  type ModelCredentialHost,
} from '../settings/modelCredentialHost'

/** 造当前宿主的凭据宿主；`available` 同时也是启动凭据门禁开不开的判据。 */
export function createHostModelCredentialHost(host: ResolvedHost): ModelCredentialHost {
  if (host.kind === 'tauri') return createTauriModelCredentialHost()
  if (host.kind === 'server') return createServerModelCredentialHost()
  return createUnavailableModelCredentialHost()
}
