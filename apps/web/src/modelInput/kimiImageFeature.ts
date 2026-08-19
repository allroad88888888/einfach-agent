import {
  imageInputCapability,
  type ImageInputCapability,
} from '@einfach-agent/ai'

const KIMI_IMAGE_GATE_REASON = 'Kimi 图片输入尚未开放。'

/** Kimi image input stays closed unless the public build flag explicitly opts in. */
export function isKimiImageInputEnabled(): boolean {
  return import.meta.env.VITE_KIMI_IMAGE_INPUT_ENABLED === 'true'
}

/** Projects the public Kimi rollout gate onto the adapter capability used by the host. */
export function imageInputCapabilityForApp(
  vendor: string,
  model: string,
): ImageInputCapability {
  const capability = imageInputCapability(vendor, model)
  if (vendor === 'kimi'
    && capability.kind === 'provider-upload'
    && !isKimiImageInputEnabled()) {
    return { kind: 'unsupported', reason: KIMI_IMAGE_GATE_REASON }
  }
  return capability
}
