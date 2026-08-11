import type { ModelSettings } from '@web-agent/core/state/core.type'
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

  if (settings.vendor === 'kimi') {
    if (settings.region === undefined || settings.region === 'cn') {
      return { ok: true, id: 'kimi-cn' }
    }
    return { ok: false, error: 'unsupported-kimi-region' }
  }

  return { ok: false, error: 'unsupported-model-vendor' }
}
