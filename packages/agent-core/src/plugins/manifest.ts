// agent-core/plugins/manifest.ts —— 把未知输入解析成插件 manifest
// ---------------------------------------------------------------------------
// 纯逻辑：无 IO、无宿主依赖，不读文件也不 import 插件。调用方（P3 扫描器 / P4 加载器）
// 负责把 plugin.json 或 package.json 的 webAgent 字段读成 unknown 再交给这里。
//
// 硬契约：任何坏输入都归为结构化诊断，绝不抛异常——坏插件不许拖垮扫描与启动
// （docs/plugin-ecosystem-blueprint.md 第 3.3 节）。
//
// 本文件只做编排：单字段校验在 manifestFields.ts，版本区间语义在 apiVersion.ts。

import {
  isPlainRecord,
  parseApiVersionField,
  parseCapabilitiesField,
  parseEntryField,
  parseIdField,
  parseVersionField,
  requireText,
  type Diagnostics,
} from './manifestFields'
import {
  MAX_PLUGIN_NAME_LENGTH,
  TIMELINE_PERSIST_CAPABILITY,
  type ManifestParseResult,
} from './manifestTypes'

export {
  checkApiVersionCompatibility,
  isApiVersionCompatible,
} from './apiVersion'
export * from './manifestTypes'

/**
 * 解析并归一化一份 manifest。
 *
 * - 成功：返回归一化后的 manifest 与 warnings（当前只有 `capability_not_grantable`）。
 * - 失败：一次返回全部诊断，设置页能一屏列完，不用挤牙膏式反复修。
 *
 * 任何输入都不会抛异常。
 */
export function parsePluginManifest(raw: unknown): ManifestParseResult {
  if (!isPlainRecord(raw)) {
    return {
      ok: false,
      diagnostics: [{ code: 'not_an_object', message: 'manifest 必须是一个 JSON 对象' }],
    }
  }

  const diagnostics: Diagnostics = []
  // 六个字段各自独立校验：不短路，好让一次解析暴露全部问题。
  const id = parseIdField(raw, diagnostics)
  const name = requireText(raw, 'name', MAX_PLUGIN_NAME_LENGTH, diagnostics)
  const version = parseVersionField(raw, diagnostics)
  const apiVersion = parseApiVersionField(raw, diagnostics)
  const capabilities = parseCapabilitiesField(raw, diagnostics)
  const entry = parseEntryField(raw, diagnostics)

  if (
    id === undefined
    || name === undefined
    || version === undefined
    || apiVersion === undefined
    || capabilities === undefined
    || entry === undefined
  ) {
    return { ok: false, diagnostics }
  }

  const requestsTimelinePersist = capabilities.includes(TIMELINE_PERSIST_CAPABILITY)
  const warnings: Diagnostics = []
  if (requestsTimelinePersist) {
    // 解析层允许申报，但宿主必须拒绝授予：R5 未批前不留任何临时通道（蓝图第 7 节）。
    warnings.push({
      code: 'capability_not_grantable',
      field: 'capabilities',
      message: '插件申报了 `timeline.persist`，当前版本不会授予该能力',
    })
  }

  return {
    ok: true,
    manifest: { id, name, version, apiVersion, capabilities, entry, requestsTimelinePersist },
    warnings,
  }
}
