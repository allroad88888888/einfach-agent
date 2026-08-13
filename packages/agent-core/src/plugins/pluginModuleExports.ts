// agent-core/plugins/pluginModuleExports.ts —— 从插件模块命名空间里取出 branded core 插件
// ---------------------------------------------------------------------------
// 只负责一件事：把 importModule 返回的任意值，判成「一个 definePlugin 产物」或「一条拒绝理由」。
// 不做 IO、不安装、不碰 registry。
//
// 契约来自 docs/plugin-ecosystem-blueprint.md 第 3.2 节：入口的默认导出（或具名 `corePlugin`）
// 必须是 definePlugin 的产物，由 isPublicPlugin 的 branded 检查把关，裸对象一律拒绝。
// 复用 runtime/core/pluginContracts 的既有品牌，不另造一套校验。

import { isPublicPlugin, type PublicPlugin } from '../runtime/core/pluginContracts'

/** 具名导出的约定名；与蓝图第 3.2 节一致（react 侧对应 `reactPlugin`，不归本加载器）。 */
export const CORE_PLUGIN_EXPORT_NAME = 'corePlugin'

export type CorePluginExportResult =
  | { readonly ok: true; readonly plugin: PublicPlugin; readonly exportName: 'default' | 'corePlugin' }
  | { readonly ok: false; readonly reason: string }

function candidateOf(moduleNamespace: object, key: 'default' | 'corePlugin'): unknown {
  return (moduleNamespace as Record<string, unknown>)[key]
}

/**
 * 解析 core 插件导出。
 *
 * 顺序：先默认导出，再具名 `corePlugin`——两个都在时取第一个通过 branded 校验的，
 * 因为「默认导出是插件本体」是文档里的主形态，具名导出只是包插件的备选。
 *
 * 拒绝而不是抛错：调用方把 reason 记成该插件的诊断，其余插件照常加载。
 */
export function resolveCorePluginExport(moduleNamespace: unknown): CorePluginExportResult {
  if (typeof moduleNamespace !== 'object' || moduleNamespace === null) {
    return { ok: false, reason: `入口模块导出的不是对象（实际为 ${describe(moduleNamespace)}）` }
  }

  const keys = ['default', CORE_PLUGIN_EXPORT_NAME] as const
  let sawCandidate = false
  for (const key of keys) {
    const candidate = candidateOf(moduleNamespace, key)
    if (candidate === undefined) continue
    sawCandidate = true
    if (isPublicPlugin(candidate)) return { ok: true, plugin: candidate, exportName: key }
  }

  if (!sawCandidate) {
    return {
      ok: false,
      reason: `入口模块既没有默认导出也没有具名 \`${CORE_PLUGIN_EXPORT_NAME}\` 导出`,
    }
  }
  return {
    ok: false,
    reason: '入口导出不是 definePlugin 的产物（裸对象、类实例与函数一律拒绝）',
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  return typeof value
}
