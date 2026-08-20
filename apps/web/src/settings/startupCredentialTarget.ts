import type { ModelSettings } from '@einfach-agent/core'
import { kimiRegionSetting } from '../modelInput/kimiRegionSetting'
import type { ModelCredentialId } from './modelCredentialHost'

export type StartupCredentialTargetResolution =
  | { ok: true; id: ModelCredentialId }
  | {
    ok: false
    error: 'unsupported-model-vendor' | 'unsupported-kimi-region'
  }

/** Resolves the credential required before the current session can enter the desktop workspace. */
export function resolveStartupCredentialTarget(
  settings?: Readonly<ModelSettings>,
): StartupCredentialTargetResolution {
  if (!settings || settings.vendor === 'deepseek') {
    return { ok: true, id: 'deepseek-default' }
  }

  if (settings.vendor === 'glm') {
    return { ok: true, id: 'glm-default' }
  }

  // openai-compat 的门禁只看**那把 Key**。接入点登记不进这道门：它有自己的登记入口，而且
  // 「没登记」的后果是请求被判成目标未获允许——一句准确的运行时错误，不是一个需要在启动时
  // 拦下来的空状态。把两件事都塞进这道门会让用户在一个只收 API Key 的框前面卡住，
  // 而他真正缺的是地址。
  if (settings.vendor === 'openai-compat') {
    return { ok: true, id: 'openai-compat-default' }
  }

  if (settings.vendor === 'kimi') {
    const region = kimiRegionSetting(settings)
    if (region === undefined || region === 'cn') {
      return { ok: true, id: 'kimi-cn' }
    }
    return { ok: false, error: 'unsupported-kimi-region' }
  }

  return { ok: false, error: 'unsupported-model-vendor' }
}
