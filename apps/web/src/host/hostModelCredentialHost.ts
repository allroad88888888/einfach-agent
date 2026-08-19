// 选出当前宿主保存模型 API Key 的通路。
// ---------------------------------------------------------------------------
// 只有桌面原生层能读写 `~/.webAgent/config.json`，也只有它的 IPC 响应保证不回传 Key 本身。
// 其余宿主拿到的是那个如实回答「模型密钥只能在桌面应用配置文件中保存」的实现——它的
// `available` 为 false，设置面板据此把输入框整块收起来，而不是给出一个存不进去的框。
//
// 【server 宿主也走 unavailable，与 static 同】server 版凭据宿主是 M4。在它落地之前，让浏览器
// 侧出现任何一条写 Key 的通路都等于把 Key 交给前端保管——本仓库的纪律是真实 Key 只由桌面
// 原生层读，前端只见受管凭据标记。
import type { ResolvedHost } from './resolveHost'
import {
  createTauriModelCredentialHost,
  createUnavailableModelCredentialHost,
  type ModelCredentialHost,
} from '../settings/modelCredentialHost'

/** 造当前宿主的凭据宿主；`available` 同时也是启动凭据门禁开不开的判据。 */
export function createHostModelCredentialHost(host: ResolvedHost): ModelCredentialHost {
  return host.kind === 'tauri'
    ? createTauriModelCredentialHost()
    : createUnavailableModelCredentialHost()
}
