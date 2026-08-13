// runtime/projectSkillsBridge.ts —— 从 workspace 读函数构建项目 skill loader bridge
// ---------------------------------------------------------------------------
// 本模块是 project-skills-blueprint.md 阶段 C 的接入点：把 workspace 文件系统的
// 已有机能（listWorkspaceFiles / readWorkspaceFile）包装成 loader bridge。
//
// web 端（非 Tauri）直接返回 undefined，不引入任何 workspace IO 依赖。

import type { ProjectSkillsLoaderBridge } from './core/coreInstance'
import { isTauriHost } from './hostTauri'
import { listWorkspaceFiles, readWorkspaceFile } from './workspaceRead'

/**
 * 在 Tauri 环境下构建一个 workspace bridge；web 环境返回 undefined。
 *
 * bridge 只是 workspace 读函数的轻量包装，不做额外守卫（workspace confinement
 * 由底层 Rust / workspaceRead 保证）。
 *
 * ★ 失败一律 throw，且必须带上桥的原始 error ★ —— workspaceRead 的两个函数返回的是
 *   `{ok:false, error}` 而非抛异常。直接取 `.data` 会在失败时读到 undefined，抛出的
 *   TypeError 会把「.webAgent/skills 不存在」这类真实原因替换成
 *   「Cannot read properties of undefined」，让 loader 的 diagnostics 变成噪声。
 *   loader 依赖 error 文本判定「目录不存在 ＝ 正常无项目 skills」，所以保真是硬要求。
 */
export function buildProjectSkillsWorkspaceBridge(): ProjectSkillsLoaderBridge | undefined {
  if (!isTauriHost()) return undefined

  const bridge: ProjectSkillsLoaderBridge = {
    async listFiles(dirPath, listOpts) {
      const result = await listWorkspaceFiles({
        path: dirPath,
        recursive: listOpts.recursive,
        includeHidden: listOpts.includeHidden,
        maxEntries: listOpts.maxEntries,
        workspaceRoot: listOpts.workspaceRoot,
        allowExternalPaths: listOpts.allowExternalPaths,
      })
      if (!result.ok) throw new Error(result.error)
      return { entries: result.data.entries }
    },
    async readFile(filePath, readOpts) {
      const result = await readWorkspaceFile({
        path: filePath,
        maxBytes: readOpts.maxBytes,
        workspaceRoot: readOpts.workspaceRoot,
        allowExternalPaths: readOpts.allowExternalPaths,
      })
      if (!result.ok) throw new Error(result.error)
      return { content: result.data.content }
    },
  }

  return bridge
}
