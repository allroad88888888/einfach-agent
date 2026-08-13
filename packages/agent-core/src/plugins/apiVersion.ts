// agent-core/plugins/apiVersion.ts —— 插件 apiVersion 的版本语义
// ---------------------------------------------------------------------------
// 只负责一件事：把 `x` / `x.y` / `x.y.z` 变成可比较的三元组，并回答「插件要求的 API
// 版本是否落在宿主声明的支持区间内」。解析 manifest 其余字段的逻辑不在这里。

import {
  API_VERSION_PATTERN,
  MAX_API_VERSION_LENGTH,
  type ApiVersionCompatibility,
  type PluginApiVersionRange,
  type PluginManifest,
} from './manifestTypes'

export type ApiVersionTriple = readonly [number, number, number]

/** 解析成三元组；缺省段补 0。任何不合法输入返回 undefined，不抛异常。 */
export function parseApiVersionTriple(raw: unknown): ApiVersionTriple | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  if (!value || value.length > MAX_API_VERSION_LENGTH) return undefined
  const matched = API_VERSION_PATTERN.exec(value)
  if (!matched) return undefined
  return [Number(matched[1]), Number(matched[2] ?? 0), Number(matched[3] ?? 0)]
}

/** 归一化成 `x.y.z`，让 manifest 的存储形态与哈希不受书写差异影响。 */
export function formatApiVersion(triple: ApiVersionTriple): string {
  return `${triple[0]}.${triple[1]}.${triple[2]}`
}

export function compareApiVersion(left: ApiVersionTriple, right: ApiVersionTriple): number {
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * 判定插件的 apiVersion 是否落在宿主支持区间（两端闭区间）内。
 * 不匹配不是错误而是 `incompatible`：上层据此标记该插件并跳过加载，
 * 既不崩溃也不阻塞其余插件（蓝图第 3.2/3.3 节）。
 */
export function checkApiVersionCompatibility(
  manifest: PluginManifest,
  hostRange: PluginApiVersionRange,
): ApiVersionCompatibility {
  const min = parseApiVersionTriple(hostRange.min)
  const max = parseApiVersionTriple(hostRange.max)
  if (!min || !max || compareApiVersion(min, max) > 0) {
    // 宿主自己配错区间是编程错误，但这里同样只返回诊断——判定函数不抛异常。
    return {
      compatible: false,
      diagnostic: {
        code: 'host_range_invalid',
        message: `宿主声明的 API 支持区间不合法：\`${String(hostRange.min)}\` – \`${String(hostRange.max)}\``,
      },
    }
  }

  const target = parseApiVersionTriple(manifest.apiVersion)
  if (!target) {
    return {
      compatible: false,
      diagnostic: {
        code: 'invalid_api_version',
        field: 'apiVersion',
        message: `插件的 apiVersion \`${String(manifest.apiVersion)}\` 无法解析`,
      },
    }
  }

  if (compareApiVersion(target, min) < 0 || compareApiVersion(target, max) > 0) {
    return {
      compatible: false,
      diagnostic: {
        code: 'api_version_incompatible',
        field: 'apiVersion',
        message: `插件要求 API ${manifest.apiVersion}，当前宿主支持 ${formatApiVersion(min)} – ${formatApiVersion(max)}`,
      },
    }
  }
  return { compatible: true }
}

/** checkApiVersionCompatibility 的布尔简写。 */
export function isApiVersionCompatible(
  manifest: PluginManifest,
  hostRange: PluginApiVersionRange,
): boolean {
  return checkApiVersionCompatibility(manifest, hostRange).compatible
}
