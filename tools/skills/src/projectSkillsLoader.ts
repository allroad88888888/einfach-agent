// tools-skills/projectSkillsLoader.ts —— 工作区与用户目录 Skills 的扫描与加载
// ---------------------------------------------------------------------------
// 本模块负责 IO：通过 ProjectSkillsLoaderBridge 访问文件系统，扫描 .webAgent/skills/ 与
// .claude/skills/ 两个目录，取每个 SKILL.md 的 frontmatter，再调用纯函数层构建最终快照。
//
// 同样这两个目录会被扫两遍：一遍在工作区下（`project/` 前缀），一遍在用户主目录下
// （`user/` 前缀）。两遍的差别只有「桥调用时传哪个根」——用户目录那遍把主目录当根传给桥，
// 因此路径依然是根内相对路径；读回来时用条目自带的 rootPath。
// 被符号链接进扫描根的 skill 目录走第三条路径（linkedSkillDirScan），它自带另一个根。
//
// 类型与桥接口定义在 core 的契约层；本模块只承载扫描实现。

import type { ProjectSkillsLoaderBridge } from '@web-agent/core'
import type {
  ProjectSkillsSnapshot,
  ProjectSkillEntry,
  ProjectSkillOrigin,
  ProjectSkillScanResult,
  ProjectSkillScope,
} from '@web-agent/core/skills'
import {
  buildProjectSkillEntry,
  resolveProjectSkills,
  scanRootLabel,
  FRONTMATTER_READ_LIMIT,
} from '@web-agent/core/skills'
import { scanLinkedSkillDir } from './linkedSkillDirScan'

/** 每个扫描根下的两个目录；工作区与用户主目录各扫一遍这两个。 */
const SCAN_DIRECTORIES: Array<{ path: string; origin: ProjectSkillOrigin }> = [
  { path: '.webAgent/skills', origin: 'agent' },
  { path: '.claude/skills', origin: 'claude' },
]

/** 扫描上限（目录列表与文件列表共用此值）。 */
const MAX_SCAN_ENTRIES = 2000

/** 单次 readFile 最多取多少字节（与 FRONTMATTER_READ_LIMIT 对齐，够解析 frontmatter）。 */
const SKILL_MD_READ_LIMIT = FRONTMATTER_READ_LIMIT

export interface ScanProjectSkillsOptions {
  /**
   * 用户级 skills 的扫描根（通常是主目录）。缺省 = 本宿主拿不到主目录（浏览器），只扫工作区。
   */
  userSkillsRoot?: string
}

interface ScanRoot {
  scope: ProjectSkillScope
  origin: ProjectSkillOrigin
  /** 桥调用时传的根：project 是 workspaceRoot，user 是 userSkillsRoot。 */
  root: string
  /** 相对该根的目录路径。 */
  path: string
}

/**
 * 扫描一个 workspace（外加用户主目录）下的 Skills，返回快照。
 *
 * 降级策略：
 * - 任一根目录不存在或列表失败 → 该路当空对待（不阻塞其它路），记 diagnostics
 * - 任一 SKILL.md 读失败 → 该 skill 跳过，记 diagnostics
 * - 任何 bridge 调用抛异常 → 整体降级为空快照
 *
 * 本函数由 tools-skills provider 调用。
 */
export async function scanProjectSkills(
  workspaceRoot: string,
  bridge: ProjectSkillsLoaderBridge,
  options: ScanProjectSkillsOptions = {},
): Promise<ProjectSkillsSnapshot> {
  const roots = collectScanRoots(workspaceRoot, options.userSkillsRoot)

  // 各根互不依赖，并行扫：每个根一次 list + 每个 SKILL.md 一次 read，都是 IPC 往返，
  // 串行时 32 个 skill 要排 32 个来回。
  const scans = await Promise.all(roots.map((root) => scanRoot(bridge, root)))

  return resolveProjectSkills({
    workspaceRoot,
    ...(hasUserScan(roots) ? { userSkillsRoot: options.userSkillsRoot } : {}),
    scans,
  })
}

function hasUserScan(roots: ScanRoot[]): boolean {
  return roots.some((root) => root.scope === 'user')
}

/**
 * 列出本次要扫的根。
 *
 * 主目录恰好就是当前工作区时不再扫第二遍：那两遍看的是同一批文件，只会让同一个 skill 以
 * `project/x` 和 `user/x` 两个名字进清单，模型读哪个都对、却要在清单里占两份预算。
 */
function collectScanRoots(workspaceRoot: string, userSkillsRoot?: string): ScanRoot[] {
  const roots: ScanRoot[] = SCAN_DIRECTORIES.map((directory) => ({
    scope: 'project' as const,
    origin: directory.origin,
    root: workspaceRoot,
    path: directory.path,
  }))

  if (!userSkillsRoot || userSkillsRoot === workspaceRoot) return roots

  return [
    ...roots,
    ...SCAN_DIRECTORIES.map((directory) => ({
      scope: 'user' as const,
      origin: directory.origin,
      root: userSkillsRoot,
      path: directory.path,
    })),
  ]
}

/**
 * 判定「列目录失败」是否只是「这个根下没有该目录」。
 *
 * 绝大多数 workspace 既没有 `.webAgent/skills` 也没有 `.claude/skills`，如果把它当错误记进
 * diagnostics，设置面板会对每个正常仓库常驻两条「扫描反馈」——用户看到的全是噪声，真出问题时
 * 反而淹没在里面。加上用户目录那两路后，这条更要紧：多数人只有 `~/.claude/skills` 一个。
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
  bridge: ProjectSkillsLoaderBridge,
  root: ScanRoot,
): Promise<ProjectSkillScanResult> {
  const entries: ProjectSkillEntry[] = []
  const diagnostics: string[] = []
  const label = scanRootLabel(root.scope, root.origin)
  const result: ProjectSkillScanResult = {
    scope: root.scope,
    origin: root.origin,
    entries,
    diagnostics,
  }

  let fileEntries: Array<{ path: string; type: string }>
  try {
    const listed = await bridge.listFiles(root.path, {
      recursive: true,
      includeHidden: true,
      maxEntries: MAX_SCAN_ENTRIES,
      workspaceRoot: root.root,
      // ★ 这里的越界许可只作用于「列出这一个 skills 目录」★ —— 桥在 confine 模式下会把
      // 目标在根外的 symlink 条目整条滤掉（契约测试 linked_skill_dir_is_invisible_…），
      // 于是 `.claude/skills/x -> 别处` 这种 dotfiles 写法会**静默缺席**。放开后多出来的
      // 只有「symlink 条目本身可见」：桥依然不递归进 symlink，后续读取各自以那个目录为根、
      // 不带任何越界许可（见 linkedSkillDirScan）。
      allowExternalPaths: true,
    })
    fileEntries = listed.entries
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // 目录不存在是常态（多数根都没有），静默返回空；其余失败才是值得报告的异常。
    if (!isMissingDirectoryError(message)) {
      diagnostics.push(`${label}: 列表失败 — ${message}`)
    }
    return result
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
        workspaceRoot: root.root,
        allowExternalPaths: false,
      })
      return { skillMdPath, dirName, frontmatterRaw: fileResult.content }
    } catch (err) {
      return {
        skillMdPath,
        dirName,
        error: `${label}/${dirName}: 读取 SKILL.md 失败 — `
          + `${err instanceof Error ? err.message : String(err)}，已跳过`,
      }
    }
  }))

  // 被链接进来的 skill 目录各自当独立根再扫一次；与上面那批互不影响，并发发起。
  const linkedResults = await Promise.all(
    fileEntries
      .filter((entry) => entry.type === 'symlink' && entry.path.split('/').length === 3)
      .map((entry) => scanLinkedSkillDir(bridge, {
        scope: root.scope,
        origin: root.origin,
        root: root.root,
        relativePath: entry.path,
        label,
        maxEntries: MAX_SCAN_ENTRIES,
        maxReadBytes: SKILL_MD_READ_LIMIT,
      })),
  )
  for (const linked of linkedResults) {
    diagnostics.push(...linked.diagnostics)
    if (linked.entry) entries.push(linked.entry)
  }

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

    const built = buildProjectSkillEntry({
      dirName: item.dirName,
      origin: root.origin,
      scope: root.scope,
      rootPath: root.root,
      filePath: item.skillMdPath,
      frontmatterRaw: item.frontmatterRaw,
      resourceFiles,
    })

    diagnostics.push(...built.diagnostics)
    if (built.entry) entries.push(built.entry)
  }

  return result
}
