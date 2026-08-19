// 选出当前宿主保存模型 API Key 的通路。
// ---------------------------------------------------------------------------
// **真实 Key 从不由前端保管**：浏览器把它经 `/api/invoke/model_credential_*` 交给本机 Node 后端，
// 由后端写进 `~/.webAgent/config.json`，三条命令的返回体只有 `{ configured, source }`、
// **任何路径都不回传 Key 本身**（M4 有正面用例钉死）。
//
// static 宿主拿到的是那个如实回答「模型密钥只能由本机后端保存」的实现——它的 `available` 为
// false，设置面板据此把输入框整块收起来，而不是给出一个存不进去的框。它背后压根没有能写文件的机器。
//
// 【T1 删掉了什么】曾有第三态 `tauri`，Key 由桌面原生层读写同一份配置文件。桌面端退出后
// 本机 Node 后端是唯一的宿主通路。
import type { ResolvedHost } from './resolveHost'
import { createServerModelCredentialHost } from '../settings/serverModelCredentialHost'
import {
  createUnavailableModelCredentialHost,
  type ModelCredentialHost,
} from '../settings/modelCredentialHost'

/** 造当前宿主的凭据宿主；`available` 同时也是启动凭据门禁开不开的判据。 */
export function createHostModelCredentialHost(host: ResolvedHost): ModelCredentialHost {
  if (host.kind === 'server') return createServerModelCredentialHost()
  return createUnavailableModelCredentialHost()
}
