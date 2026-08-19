// tools-skills/linkedSkillDirScan.ts —— 把「被符号链接进扫描根的 skill 目录」当独立根扫一次
// ---------------------------------------------------------------------------
// 为什么要单独一条路径：`.claude/skills/<name>` 指向仓库外某处，是 dotfiles 共享 skill 的常见
// 写法（本机 20 个用户 skill 里有 5 个是这样）。而桥的列目录既不递归进 symlink，也会在 confine
// 模式下把「目标在根外」的条目整条滤掉——两条都由 apps/desktop 的
// workspace_read_confinement_tests.rs 两个 linked_skill_dir_* 契约测试钉住。
//
// 于是 loader 用外部可见的列表拿到 symlink 条目本身，再把**它自己**当 workspace root 传回桥：
// canonicalize 后就是目标目录，目录内文件是根内相对路径，读取无需任何越界权限。

import type { ProjectSkillsLoaderBridge } from '@einfach-agent/core'
import type {
  ProjectSkillEntry,
  ProjectSkillOrigin,
  ProjectSkillScope,
} from '@einfach-agent/core/skills'
import { buildProjectSkillEntry } from '@einfach-agent/core/skills'

export interface LinkedSkillDirInput {
  scope: ProjectSkillScope
  origin: ProjectSkillOrigin
  /** 扫描根的绝对路径（工作区或主目录）。 */
  root: string
  /** symlink 条目相对扫描根的路径，形如 `.claude/skills/<name>`。 */
  relativePath: string
  /** 诊断前缀，如 `~/.claude/skills`。 */
  label: string
  maxEntries: number
  maxReadBytes: number
}

export interface LinkedSkillDirResult {
  entry?: ProjectSkillEntry
  diagnostics: string[]
}

/**
 * 扫描一个被链接进来的 skill 目录。
 *
 * 链接指向的不是 skill 目录（没有顶层 SKILL.md）时静默跳过：`.claude/skills` 下放一个指向
 * 别处的链接不一定是 skill，报错反而误导。真正的失败（列不动、读不出）才记诊断。
 */
export async function scanLinkedSkillDir(
  bridge: ProjectSkillsLoaderBridge,
  input: LinkedSkillDirInput,
): Promise<LinkedSkillDirResult> {
  const dirName = input.relativePath.split('/').pop() ?? input.relativePath
  const rootPath = `${input.root}/${input.relativePath}`
  const diagnostics: string[] = []

  let files: Array<{ path: string; type: string }>
  try {
    const listed = await bridge.listFiles('.', {
      recursive: true,
      includeHidden: true,
      maxEntries: input.maxEntries,
      workspaceRoot: rootPath,
      allowExternalPaths: false,
    })
    files = listed.entries
  } catch (err) {
    diagnostics.push(
      `${input.label}/${dirName}: 符号链接目标无法列出 — `
      + `${err instanceof Error ? err.message : String(err)}，已跳过`,
    )
    return { diagnostics }
  }

  if (!files.some((file) => file.type === 'file' && file.path === 'SKILL.md')) {
    return { diagnostics }
  }

  let frontmatterRaw: string
  try {
    const read = await bridge.readFile('SKILL.md', {
      maxBytes: input.maxReadBytes,
      workspaceRoot: rootPath,
      allowExternalPaths: false,
    })
    frontmatterRaw = read.content
  } catch (err) {
    diagnostics.push(
      `${input.label}/${dirName}: 读取 SKILL.md 失败 — `
      + `${err instanceof Error ? err.message : String(err)}，已跳过`,
    )
    return { diagnostics }
  }

  const built = buildProjectSkillEntry({
    dirName,
    origin: input.origin,
    scope: input.scope,
    rootPath,
    filePath: 'SKILL.md',
    frontmatterRaw,
    resourceFiles: files
      .filter((file) => file.type === 'file' && file.path !== 'SKILL.md')
      .map((file) => ({ relativePath: file.path, workspacePath: file.path })),
  })

  return { entry: built.entry, diagnostics: [...diagnostics, ...built.diagnostics] }
}
