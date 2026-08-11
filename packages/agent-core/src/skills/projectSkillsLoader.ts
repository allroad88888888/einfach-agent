// skills/projectSkillsLoader.ts —— 项目 Skills 扫描与加载
// ---------------------------------------------------------------------------
// 本模块负责 IO：通过 ProjectSkillsLoaderBridge 访问 workspace 文件系统，
// 扫描 .webAgent/skills/ 与 .claude/skills/ 目录，取每个 SKILL.md 的 frontmatter，
// 再调用 projectSkills.ts 的纯函数构建最终快照。
//
// 类型与桥接口定义在 coreInstance.ts（ProjectSkillsLoaderBridge / ProjectSkillsStore），
// 本模块是纯实现，不 import coreInstance 以避免成环。

import type { ProjectSkillsLoaderBridge } from '../runtime/core/coreInstance'
import type {
  ProjectSkillsSnapshot,
  ProjectSkillEntry,
  ProjectSkillOrigin,
} from './projectSkills'
import {
  buildProjectSkillEntry,
  resolveProjectSkills,
  FRONTMATTER_READ_LIMIT,
} from './projectSkills'

// 扫描两个根目录
const SCAN_ROOTS: Array<{ path: string; origin: ProjectSkillOrigin }> = [
  { path: '.webAgent/skills', origin: 'agent' },
  { path: '.claude/skills', origin: 'claude' },
]

/** 扫描上限（目录列表与文件列表共用此值）。 */
const MAX_SCAN_ENTRIES = 2000

/** 单次 readFile 最多取多少字节（与 FRONTMATTER_READ_LIMIT 对齐，够解析 frontmatter）。 */
const SKILL_MD_READ_LIMIT = FRONTMATTER_READ_LIMIT

/**
 * 扫描一个 workspace 下的项目 Skills，返回快照。
 *
 * 降级策略：
 * - 任一根目录不存在或列表失败 → 该路当空对待（不阻塞另一路），记 diagnostics
 * - 任一 SKILL.md 读失败 → 该 skill 跳过，记 diagnostics
 * - 任何 bridge 调用抛异常 → 整体降级为空快照
 *
 * 本函数由 CoreInstance.projectSkills.refresh 调用，外界不应直接 import。
 */
export async function scanProjectSkills(
  workspaceRoot: string,
  bridge: ProjectSkillsLoaderBridge,
): Promise<ProjectSkillsSnapshot> {
  // 两个根互不依赖，并行扫：每个根一次 list + 每个 SKILL.md 一次 read，都是 IPC 往返，
  // 串行时 32 个 skill 要排 32 个来回。
  const [agentResult, claudeResult] = await Promise.all([
    scanRoot(workspaceRoot, bridge, SCAN_ROOTS[0]),
    scanRoot(workspaceRoot, bridge, SCAN_ROOTS[1]),
  ])

  return resolveProjectSkills({
    workspaceRoot,
    agentEntries: agentResult.entries,
    agentDiagnostics: agentResult.diagnostics,
    claudeEntries: claudeResult.entries,
    claudeDiagnostics: claudeResult.diagnostics,
  })
}

interface ScanRootResult {
  entries: ProjectSkillEntry[]
  diagnostics: string[]
}

/**
 * 判定「列目录失败」是否只是「这个仓库没有该目录」。
 *
 * 绝大多数 workspace 既没有 `.webAgent/skills` 也没有 `.claude/skills`，如果把它当错误记进
 * diagnostics，设置面板会对每个正常仓库常驻两条「扫描反馈」——用户看到的全是噪声，真出问题时
 * 反而淹没在里面。
 *
 * 判据取自 apps/desktop/src/workspace_read.rs 的错误文案（`path ... is not accessible: ...`，
 * 底层 io::Error 会带 "No such file or directory"）。Rust 侧改文案时这里最坏退化成「多记一条
 * 诊断」，不会造成功能损坏——所以用字符串判定是可接受的，不值得为它加一个跨端的错误码协议。
 */
function isMissingDirectoryError(message: string): boolean {
  const normalized = message.toLowerCase()
  return normalized.includes('is not accessible')
    || normalized.includes('no such file')
    || normalized.includes('cannot find the path')
    || normalized.includes('cannot find the file')
}

async function scanRoot(
  workspaceRoot: string,
  bridge: ProjectSkillsLoaderBridge,
  root: { path: string; origin: ProjectSkillOrigin },
): Promise<ScanRootResult> {
  const entries: ProjectSkillEntry[] = []
  const diagnostics: string[] = []

  let fileEntries: Array<{ path: string; type: string }>
  try {
    const result = await bridge.listFiles(root.path, {
      recursive: true,
      includeHidden: true,
      maxEntries: MAX_SCAN_ENTRIES,
      workspaceRoot,
      allowExternalPaths: false,
    })
    fileEntries = result.entries
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // 目录不存在是常态（多数仓库两个根都没有），静默返回空；其余失败才是值得报告的异常。
    if (!isMissingDirectoryError(message)) {
      diagnostics.push(`${root.path}: 列表失败 — ${message}`)
    }
    return { entries, diagnostics }
  }

  // 只认扫描根的直接子目录：路径必为 ['.webAgent', 'skills', '<dirName>', 'SKILL.md'] 四段。
  // 更深层的 SKILL.md（例如 skills/a/b/SKILL.md）按蓝图约定不是 skill，静默跳过——它多半是
  // 某个 skill 自带的示例资源，报警反而误导。
  const skillMdPaths = fileEntries
    .filter((entry) => entry.type === 'file' && entry.path.endsWith('/SKILL.md'))
    .map((entry) => entry.path)
    .filter((path) => path.split('/').length === 4)

  // 每个 SKILL.md 一次读取，彼此独立 → 并发发起；失败的那个降级成 diagnostics，不影响其它。
  const loaded = await Promise.all(skillMdPaths.map(async (skillMdPath) => {
    const dirName = skillMdPath.split('/')[2]
    try {
      const fileResult = await bridge.readFile(skillMdPath, {
        maxBytes: SKILL_MD_READ_LIMIT,
        workspaceRoot,
        allowExternalPaths: false,
      })
      return { skillMdPath, dirName, frontmatterRaw: fileResult.content }
    } catch (err) {
      return {
        skillMdPath,
        dirName,
        error: `${root.path}/${dirName}: 读取 SKILL.md 失败 — `
          + `${err instanceof Error ? err.message : String(err)}，已跳过`,
      }
    }
  }))

  for (const item of loaded) {
    if (item.frontmatterRaw === undefined) {
      if (item.error) diagnostics.push(item.error)
      continue
    }

    // 该 skill 目录下除 SKILL.md 外的文件即候选 L3 资源（白名单过滤在纯函数层做）。
    const skillDir = item.skillMdPath.slice(0, -'/SKILL.md'.length)
    const resourceFiles = fileEntries
      .filter((entry) =>
        entry.type === 'file'
        && entry.path.startsWith(`${skillDir}/`)
        && entry.path !== item.skillMdPath,
      )
      .map((entry) => ({
        relativePath: entry.path.slice(skillDir.length + 1),
        workspacePath: entry.path,
      }))

    const result = buildProjectSkillEntry({
      dirName: item.dirName,
      origin: root.origin,
      filePath: item.skillMdPath,
      frontmatterRaw: item.frontmatterRaw,
      resourceFiles,
    })

    diagnostics.push(...result.diagnostics)
    if (result.entry) entries.push(result.entry)
  }

  return { entries, diagnostics }
}
