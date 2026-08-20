// 选出当前宿主登记 openai-compat 接入点的通路。
// ---------------------------------------------------------------------------
// 判据与 `hostModelCredentialHost.ts` **必须是同一个**（`host.kind === 'server'`）：凭据存得进去
// 而接入点存不进去（或反过来）时，用户会拿到一个「Key 保存成功、地址却说没有后端」的自相矛盾
// 的面板。两件事在同一台本机 Node 后端上落同一份 `~/.webAgent/config.json`，能力是一体的。

import type { ResolvedHost } from './resolveHost'
import { createServerModelEndpointHost } from '../settings/serverModelEndpointHost'
import {
  createUnavailableModelEndpointHost,
  type ModelEndpointHost,
} from '../settings/modelEndpointHost'

/** 造当前宿主的接入点宿主；`available` 同时也是设置面板收不收起输入框的判据。 */
export function createHostModelEndpointHost(host: ResolvedHost): ModelEndpointHost {
  if (host.kind === 'server') return createServerModelEndpointHost()
  return createUnavailableModelEndpointHost()
}
