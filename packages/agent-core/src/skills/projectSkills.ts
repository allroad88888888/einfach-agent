// skills/projectSkills.ts —— 一个 SKILL.md 变成一条清单条目的纯函数层（零 IO，全单测）
// ---------------------------------------------------------------------------
// 本模块是 project-skills-blueprint.md 阶段 A 的产物：frontmatter 解析、
// name/description 卫生化、单条条目构建与它自己的 diagnostics。
// 全部是「输入 = 一个文件的文本 + 它的路径，输出 = 一条条目」的纯函数，可全量单测。
//
// 多个扫描根合并成一份快照（撞名裁决、上限截断、诊断合并）住 projectSkillsSnapshot.ts；
// 调用方（projectSkillsLoader.ts / modelRun）负责 IO。本模块不 import 任何
// runtime/state/UI，也不依赖 workspace 桥。

// ===========================================================================
// 常量
// ===========================================================================

/** 单 skill 最多资源数；超出忽略并记 diagnostics。 */
export const MAX_PROJECT_RESOURCES_PER_SKILL = 32

/** 扫描 SKILL.md 时只读前 4KB 取 frontmatter（足够容纳三个字段的 YAML 块）。 */
export const FRONTMATTER_READ_LIMIT = 4096

/**
 * L3 资源扩展名白名单。
 * 只允许文本文件，避免把二进制读进上下文。
 */
export const PROJECT_RESOURCE_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.ts',
  '.tsx',
  '.js',
  '.sql',
])

/** name 必须满足的格式：小写字母、数字、短横线，1-64 字符。 */
const VALID_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/

// ===========================================================================
// 类型
// ===========================================================================

/** 项目 skill 的来源目录。 */
export type ProjectSkillOrigin = 'agent' | 'claude'

/**
 * skill 的作用域：扫描根是工作区还是用户主目录。
 *
 * 两个作用域各占一个**名字前缀**（`project/` 与 `user/`），因此永不撞名：同名的
 * `.claude/skills/deploy` 在工作区里是 `project/deploy`、在主目录里是 `user/deploy`，
 * 模型看到的是两条清单项，用户也能分别停用。撞名裁决只发生在同一作用域的两个目录之间。
 */
export type ProjectSkillScope = 'project' | 'user'

/**
 * 扫描根的显示名，用于 diagnostics 与 UI。
 *
 * user 作用域带 `~/` 前缀：两个作用域扫的是同名的两个目录，诊断里不带前缀就会出现
 * 「`.claude/skills/foo`: 缺少 description」这种指不出到底是哪一份文件的消息。
 */
export function scanRootLabel(scope: ProjectSkillScope, origin: ProjectSkillOrigin): string {
  const directory = origin === 'agent' ? '.webAgent/skills' : '.claude/skills'
  return scope === 'user' ? `~/${directory}` : directory
}

/**
 * 从 skill 名反推作用域；内置 skill（无前缀）返回 undefined。
 *
 * 「这个名字是不是扫描来的」是 skill_read / skill_search / 停用偏好共用的判据，各写一份
 * `startsWith('project/')` 就会在加第二个前缀时漏掉某一处——加 `user/` 那次正是这样发现的。
 */
export function skillScopeFromName(name: string): ProjectSkillScope | undefined {
  if (name.startsWith('project/')) return 'project'
  if (name.startsWith('user/')) return 'user'
  return undefined
}

/**
 * 扫描产出的快照条目：只含元数据与路径，不含正文。
 * 清单与 skill_read 都基于此结构。
 */
export interface ProjectSkillEntry {
  /** 清单与 skill_read 使用的名字，恒为 `<scope>/<dir-name>`。 */
  name: string
  /** frontmatter description，单行化并截断后的结果。 */
  description: string
  /** frontmatter triggers（可选），仅供 skill_search 检索。 */
  triggers: string[]
  /**
   * 本条目路径相对的**绝对**根：工作区 skill 是 workspaceRoot，主目录 skill 是主目录，
   * 被符号链接进来的 skill 是**它自己那个目录**（见 loader 的 linkedSkillDir）。
   *
   * 每条条目自带根、而不是「按 scope 去快照上取」，是因为第三种情况根本不在快照的两个根里；
   * 一个双向规则（缺省时按 scope 回退）迟早会在加第四种来源时被漏掉一处。
   */
  rootPath: string
  /** SKILL.md 相对 `rootPath` 的路径。 */
  filePath: string
  /** 资源键（相对 skill 目录）→ 相对同一个 `rootPath` 的路径。白名单过滤后的结果。 */
  resources: Record<string, string>
  /** 'agent' | 'claude'，用于告警与 UI 展示。 */
  origin: ProjectSkillOrigin
  /** 'project' | 'user'，决定名字前缀与 filePath 相对的根。 */
  scope: ProjectSkillScope
}

/** 一次扫描产出的完整快照。 */
export interface ProjectSkillsSnapshot {
  workspaceRoot: string
  /**
   * 用户级 skills 的扫描根（通常是主目录）。宿主拿不到主目录（浏览器）或没扫用户目录时缺省，
   * 此时快照里不会有 `user/` 条目。
   */
  userSkillsRoot?: string
  entries: ProjectSkillEntry[]
  /** 扫描期的降级信息（读失败、超限截断、撞名落选），供 UI 与 trace 展示，不进 prompt。 */
  diagnostics: string[]
}

/** frontmatter 解析结果。fields 只有已成功解析的值；unknownKeys 是被忽略的键名。 */
export interface ProjectSkillFrontmatter {
  name?: string
  description?: string
  triggers?: string[]
  unknownKeys: string[]
}

// ===========================================================================
// Frontmatter 解析
// ===========================================================================

/**
 * 切开 SKILL.md 的 frontmatter 与正文。
 *
 * 唯一的围栏判定处：`parseFrontmatter`（取元数据）与 `skill_read`（取正文）必须对「哪里是
 * frontmatter」给出逐字一致的答案，各写一份迟早漂移——正文里一条 markdown 分隔线就足以让两边
 * 对同一个文件切在不同位置。
 *
 * 规则：文件须以 `---` 独占的首行开头；结束围栏是后续【独占一行】的 `---`（前后无其它字符）。
 * 不满足则视为「无 frontmatter」，整个文件都是正文。
 */
export function splitFrontmatter(raw: string): { frontmatter?: string; body: string } {
  const openMatch = /^---\r?\n/.exec(raw)
  if (!openMatch) return { body: raw }

  const afterOpening = raw.slice(openMatch[0].length)
  // 结束围栏必须独占一行：`\n---` 后只允许换行或文件结束，从而 `----` / `--- x` 都不算。
  const closeMatch = /\r?\n---[ \t]*(\r?\n|$)/.exec(afterOpening)
  if (!closeMatch) return { body: raw }

  return {
    frontmatter: afterOpening.slice(0, closeMatch.index),
    // 吃掉围栏与正文之间的空行（`---\n\n# 标题` 是最常见的写法，那个空行不是正文的一部分）。
    // 只吃换行、不 trimStart：正文首行如果是缩进代码块，缩进有语义。
    body: afterOpening.slice(closeMatch.index + closeMatch[0].length).replace(/^(?:\r?\n)+/, ''),
  }
}

/**
 * 解析 SKILL.md 开头的 YAML frontmatter。
 *
 * 围栏判定见 splitFrontmatter。只支持 name / description / triggers 三个键，
 * 值只支持单行 scalar 与行内数组 `[a, b, c]`，不支持嵌套/多行。
 * 未知键忽略并记录到 unknownKeys；语法不能识别的行跳过并告警。
 *
 * 无 frontmatter 或围栏不完整返回所有字段均为默认值的对象（unknownKeys 空）。
 */
export function parseFrontmatter(raw: string): ProjectSkillFrontmatter {
  const fields: ProjectSkillFrontmatter = { unknownKeys: [] }

  const { frontmatter } = splitFrontmatter(raw)
  if (frontmatter === undefined) return fields

  const lines = frontmatter.split(/\r?\n/)

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const colonIndex = trimmed.indexOf(':')
    if (colonIndex === -1) {
      fields.unknownKeys.push(`(malformed line) ${trimmed.slice(0, 40)}`)
      continue
    }

    const key = trimmed.slice(0, colonIndex).trim()
    const value = trimmed.slice(colonIndex + 1).trim()

    switch (key) {
      case 'name': {
        const parsed = parseScalarValue(value)
        if (typeof parsed === 'string' && parsed.length > 0) fields.name = parsed
        break
      }
      case 'description': {
        const parsed = parseScalarValue(value)
        if (typeof parsed === 'string' && parsed.length > 0) fields.description = parsed
        break
      }
      case 'triggers': {
        const parsed = parseArrayValue(value)
        if (parsed !== undefined) {
          fields.triggers = parsed.filter((v): v is string => typeof v === 'string' && v.length > 0)
        }
        break
      }
      default:
        fields.unknownKeys.push(key)
        break
    }
  }

  return fields
}

/** 解析单行 scalar 值：支持无引号、单引号、双引号。返回 undefined 表示无法解析。 */
function parseScalarValue(raw: string): string | undefined {
  if (!raw) return undefined

  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1)
      .replace(/\\\\/g, '\x00')
      .replace(/\\"/g, '"')
      .replace(/\x00/g, '\\')
  }

  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1)
  }

  // YAML 的行内注释要求 `#` 前有空白。不照这条办就会把正文里的 `#` 当注释吃掉——
  // `description: 修复 #123 的问题` 会被截成「修复」，而这是中文描述里很自然的写法。
  const commentIndex = findUnquotedComment(raw)
  if (commentIndex >= 0) raw = raw.slice(0, commentIndex).trim()

  return raw || undefined
}

/** 解析行内数组值 [a, b, c]。不支持嵌套；返回 undefined 表示无法解析。 */
function parseArrayValue(raw: string): (string | undefined)[] | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return undefined

  const inner = trimmed.slice(1, -1)
  if (!inner.trim()) return []

  const items: (string | undefined)[] = []
  let current = ''
  let inQuote: '"' | "'" | null = null

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null
      } else {
        current += ch
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch
    } else if (ch === ',') {
      items.push(current.trim() || undefined)
      current = ''
    } else {
      current += ch
    }
  }
  items.push(current.trim() || undefined)

  return items.length > 0 ? items : undefined
}

/** 找引号外的行内注释起点（YAML：`#` 前须有空白）。没有则返回 -1。 */
function findUnquotedComment(raw: string): number {
  let inQuote: '"' | "'" | null = null
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (inQuote) {
      if (c === inQuote) inQuote = null
    } else if (c === '"' || c === "'") {
      inQuote = c
    } else if (c === '#' && i > 0 && /\s/.test(raw[i - 1])) {
      return i
    }
  }
  return -1
}

// ===========================================================================
// 卫生化
// ===========================================================================

export function sanitizeName(name: string): string | undefined {
  const trimmed = name.trim().toLowerCase()
  return VALID_NAME.test(trimmed) ? trimmed : undefined
}

/** 清单单条 description 的字符预算（不含截断标记）。 */
export const MAX_DESCRIPTION_CHARS = 160

/**
 * 卫生化 description：剥控制字符、折成单行、按预算截断。
 *
 * ★ 截断必须留标记 ★ —— 实测 `.claude/skills` 生态里的 description 普遍超过 160 字符，
 * 而超出部分往往正是「何时不用」的限制条件（实例：codegraph 的
 * 「…索引未覆盖的文件也不要用」被截在「也」字）。无标记地截在句中，模型读到的是一句
 * 完整但语义被砍掉一半的话，最坏情况会把限制条件读反。带上 `…` 至少让「这里还有话没说完」
 * 是可见的，并顺带回一条 diagnostics 让仓库作者去改短。
 */
export function sanitizeDescription(description: string): { value: string; truncated: boolean } | undefined {
  const clean = description.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
  const firstLine = clean.split(/\r?\n/)[0].trim()
  if (!firstLine) return undefined
  if (firstLine.length <= MAX_DESCRIPTION_CHARS) return { value: firstLine, truncated: false }
  return { value: `${firstLine.slice(0, MAX_DESCRIPTION_CHARS)}…`, truncated: true }
}

// ===========================================================================
// 条目构建
// ===========================================================================

export function buildProjectSkillEntry(opts: {
  dirName: string
  origin: ProjectSkillOrigin
  /** 决定名字前缀；由扫描方按扫描根显式给出，没有默认值。 */
  scope: ProjectSkillScope
  /** 本条目路径相对的绝对根，见 ProjectSkillEntry.rootPath。 */
  rootPath: string
  filePath: string
  frontmatterRaw: string
  /** workspacePath 是相对 rootPath 的路径（桥要求的形式），不是文件系统绝对路径。 */
  resourceFiles: Array<{ relativePath: string; workspacePath: string }>
}): { entry?: ProjectSkillEntry; diagnostics: string[] } {
  const { dirName, origin, scope, rootPath, filePath, frontmatterRaw, resourceFiles } = opts
  const diagnostics: string[] = []
  const label = `${scanRootLabel(scope, origin)}/${dirName}`

  const fm = parseFrontmatter(frontmatterRaw)

  for (const unknownKey of fm.unknownKeys) {
    if (unknownKey.startsWith('(malformed')) {
      diagnostics.push(`${label}: ${unknownKey}`)
    } else {
      diagnostics.push(`${label}: 忽略未知 frontmatter 键 "${unknownKey}"`)
    }
  }

  const rawName = fm.name ?? dirName
  const safeName = sanitizeName(rawName)
  if (!safeName) {
    diagnostics.push(
      `${label}: name "${rawName}" 不符合规范 ` +
      `[a-z0-9][a-z0-9-]{0,63}，已跳过`,
    )
    return { diagnostics }
  }

  const rawDesc = fm.description
  if (!rawDesc) {
    diagnostics.push(
      `${label}: 缺少 description（frontmatter 中未提供或为空），已跳过`,
    )
    return { diagnostics }
  }

  const safeDesc = sanitizeDescription(rawDesc)
  if (!safeDesc) {
    diagnostics.push(
      `${label}: description 卫生化后为空，已跳过`,
    )
    return { diagnostics }
  }
  if (safeDesc.truncated) {
    // 可操作的反馈：清单是模型选 skill 的唯一依据，被截掉的那半句作者自己最清楚怎么压缩。
    diagnostics.push(
      `${label}: description 超过 ${MAX_DESCRIPTION_CHARS} 字符已截断，`
      + '超出部分不会进入 skill 清单，建议改写得更短',
    )
  }

  const resources: Record<string, string> = {}
  for (const file of resourceFiles) {
    if (Object.keys(resources).length >= MAX_PROJECT_RESOURCES_PER_SKILL) {
      diagnostics.push(
        `${label}: 资源数已超过上限 ${MAX_PROJECT_RESOURCES_PER_SKILL}，` +
        `忽略 ${file.relativePath}`,
      )
      continue
    }
    const ext = file.relativePath.match(/\.[a-zA-Z0-9]+$/)?.[0]?.toLowerCase()
    if (!ext || !PROJECT_RESOURCE_EXTENSIONS.has(ext)) {
      if (ext) {
        diagnostics.push(
          `${label}: 忽略非白名单资源 "${file.relativePath}"（扩展名 ${ext}）`,
        )
      }
      continue
    }
    resources[file.relativePath] = file.workspacePath
  }

  return {
    entry: {
      name: `${scope}/${safeName}`,
      description: safeDesc.value,
      triggers: fm.triggers ?? [],
      rootPath,
      filePath,
      resources,
      origin,
      scope,
    },
    diagnostics,
  }
}

// 快照合成（多个扫描根 → 一份快照）住 projectSkillsSnapshot.ts。
