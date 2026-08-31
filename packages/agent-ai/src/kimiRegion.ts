export const KIMI_CN_BASE_URL = 'https://api.moonshot.cn/v1'
export const KIMI_GLOBAL_BASE_URL = 'https://api.moonshot.ai/v1'
export const KIMI_K3_MODEL = 'kimi-k3'
export const DEFAULT_KIMI_MODEL = KIMI_K3_MODEL

export type KimiRegion = 'cn' | 'global'

export function resolveKimiRegion(region?: KimiRegion): KimiRegion {
  return region ?? 'cn'
}

export function kimiBaseUrl(region: KimiRegion): string {
  return region === 'global' ? KIMI_GLOBAL_BASE_URL : KIMI_CN_BASE_URL
}

export function kimiReferenceScope(region: KimiRegion): string {
  return `kimi:${region}`
}
