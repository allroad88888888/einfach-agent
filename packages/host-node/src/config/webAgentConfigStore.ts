// `~/.webAgent/config.json` 的按段读写 + 旧路径迁移
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/web_agent_config_store.rs（已随 T1 删除）的 `WebAgentConfigStore`。
//
// 文件的形状是「一个 version 加任意多个具名配置段」：`mcp`、`modelCredentials`、以后还会有别的。
// 本层只认段，**不认任何一段的内容**——`mcp_config_read` 拿不到 `modelCredentials`，不是因为
// 某处写了「不许读 Key」，而是因为它请求的段名是 `mcp`，别的段根本不在返回值里。
// 未识别的顶层键原样保留：Node 宿主写一次配置不能把桌面版新加的段抹掉。

import { readFile } from 'node:fs/promises'
import type { ConfigPaths } from './configPaths'
import { writeRestrictedAtomically } from './restrictedWrite'

const CONFIG_VERSION = 1
const INVALID_FORMAT = '模型配置文件格式无效'
const UNSUPPORTED_VERSION = '模型配置文件版本不受支持'

/** 一次读回来的整份配置。`sections` 是除 `version` 外的全部顶层键。 */
interface WebAgentConfig {
  readonly version: number
  readonly sections: Map<string, unknown>
}

/** 配置段的读—改—写。回调返回 `undefined` 表示删除该段（JSON 里没有 undefined，语义不会撞）。 */
export interface WebAgentConfigStore {
  readSection(section: string): Promise<unknown>
  readSections(sections: readonly string[]): Promise<ReadonlyMap<string, unknown>>
  updateSection(section: string, update: (current: unknown) => unknown): Promise<void>
  updateSections(
    writableSections: readonly string[],
    update: (current: ReadonlyMap<string, unknown>) => ReadonlyMap<string, unknown>,
  ): Promise<void>
}

/**
 * 全进程串行化的写入队列。
 *
 * 对齐 Rust 的 `static CONFIG_LOCK: Mutex<()>`，但在 Node 里它**不是可选的**：读—改—写中间隔着
 * 两次 await，两个并发的 `mcp_config_write` 会各自读到同一份旧配置、各自写回，后写的那份把先写
 * 的键整个抹掉。Rust 靠线程锁挡这件事，Node 靠这条 Promise 链。
 *
 * 队列是模块级的（不按路径分桶）：配置写入本来就稀疏，按路径分桶只会多一张要清理的表。
 */
let configQueue: Promise<unknown> = Promise.resolve()

function withConfigLock<T>(operation: () => Promise<T>): Promise<T> {
  // 两个分支都接 `operation`：上一次操作失败不该让后面所有配置读写跟着失败。
  const running = configQueue.then(operation, operation)
  configQueue = running.then(
    () => undefined,
    () => undefined,
  )
  return running
}

function writableSectionSet(sections: readonly string[]): ReadonlySet<string> {
  if (sections.length === 0) throw new Error('配置事务至少需要一个可写段')
  const allowed = new Set<string>()
  for (const section of sections) {
    if (
      typeof section !== 'string'
      || section.length === 0
      || section.trim() !== section
      || /[\u0000-\u001f\u007f]/u.test(section)
      || section === 'version'
    ) {
      throw new Error('配置事务包含非法段名')
    }
    if (allowed.has(section)) throw new Error('配置事务包含重复段名')
    allowed.add(section)
  }
  return allowed
}

function isolatedWritableSnapshot(
  config: WebAgentConfig,
  writableSections: readonly string[],
): ReadonlyMap<string, unknown> {
  return new Map(writableSections.map((section) => [
    section,
    structuredClone(config.sections.get(section)),
  ]))
}

export function createWebAgentConfigStore(paths: ConfigPaths): WebAgentConfigStore {
  const readSections = (sections: readonly string[]) => withConfigLock(async () => {
    const config = await readConfig(paths)
    return new Map(sections.map((section) => [section, config.sections.get(section)]))
  })

  const updateSections = (
    writableSections: readonly string[],
    update: (current: ReadonlyMap<string, unknown>) => ReadonlyMap<string, unknown>,
  ) => {
    // 先校验再进读路径：非法事务不能意外触发旧配置迁移，更不能产生任何落盘。
    let allowed: ReadonlySet<string>
    try {
      allowed = writableSectionSet(writableSections)
    } catch (error) {
      return Promise.reject(error)
    }
    return withConfigLock(async () => {
      const config = await readConfig(paths)
      // 回调只能看到显式授权段；值也深隔离，绕过 Readonly 类型做原地修改不会污染待提交配置。
      const patch = update(isolatedWritableSnapshot(config, writableSections))
      const sections = new Map(config.sections)
      for (const [section, next] of patch) {
        if (!allowed.has(section)) throw new Error('配置事务试图更新未授权段')
        if (next === undefined) sections.delete(section)
        else sections.set(section, next)
      }
      const contents = serializeConfig({ version: config.version, sections })
      await writeRestrictedAtomically(paths.path, contents)
    })
  }

  return {
    async readSection(section) {
      return withConfigLock(async () => (await readConfig(paths)).sections.get(section))
    },
    readSections,
    async updateSection(section, update) {
      return updateSections([section], (current) => new Map([[section, update(current.get(section))]]))
    },
    updateSections,
  }
}

/**
 * 读整份配置。文件不存在时**才**尝试迁移旧文件；两者都没有则给一份空配置。
 *
 * 迁移挂在读路径上而不是装配时跑一次，是因为「新文件不存在」这个前提只有真正去读的那一刻才成立
 * ——桌面版和 Node 宿主可能先后写同一个文件。
 */
async function readConfig(paths: ConfigPaths): Promise<WebAgentConfig> {
  let contents: string
  try {
    contents = await readFile(paths.path, 'utf8')
  } catch (error) {
    // 只有 NotFound 才走迁移。其余读失败（EISDIR、EACCES…）必须受控失败：把它们也当成
    // 「文件不存在」会让一次权限问题表现为「配置被清空了」，而下一次写入就会真的清空它。
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('无法读取模型配置文件')
    }
    const migrated = await migrateLegacyConfig(paths)
    if (migrated === undefined) return { version: CONFIG_VERSION, sections: new Map() }
    contents = migrated
  }
  return parseConfig(contents)
}

/**
 * 把旧 `~/.web-agent/config.json` **复制**到新路径，返回它的内容；无可迁移内容时返回 `undefined`。
 *
 * 三条不变量：
 *   · `legacyPath` 为 `undefined`（设了 `WEB_AGENT_CONFIG_DIR`）时直接返回，迁移不可能发生。
 *   · 旧文件**不删除、不改写**——迁移失败或用户想退回旧版时它还在。
 *   · 旧文件解析不过就不创建新文件：先落一份坏配置再报错，等于把损坏搬到了新路径上。
 */
async function migrateLegacyConfig(paths: ConfigPaths): Promise<string | undefined> {
  if (paths.legacyPath === undefined) return undefined
  let contents: string
  try {
    contents = await readFile(paths.legacyPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error('无法读取旧模型配置文件')
  }
  try {
    parseConfig(contents)
  } catch {
    throw new Error('旧模型配置文件格式无效')
  }
  try {
    // 写原文而不是重新序列化：迁移只是搬家，重排键会让「新旧两份是不是同一份」失去逐字判据。
    await writeRestrictedAtomically(paths.path, contents)
  } catch {
    throw new Error('无法迁移旧模型配置文件')
  }
  return contents
}

/**
 * 解析并校验版本。
 *
 * `version` 缺失当作 1（对齐 serde 的 `#[serde(default)]`）；存在但不是 0–255 的整数则是格式错误
 * ——包括 `null` 与 `"1"`，因为 Rust 那边 `u8` 反序列化同样拒绝它们。JSON 里不存在 `undefined`，
 * 所以「取到 undefined」与「键缺失」是同一件事，不需要 `Object.hasOwn` 去分辨。
 */
function parseConfig(contents: string): WebAgentConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    throw new Error(INVALID_FORMAT)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(INVALID_FORMAT)
  }
  const entries = Object.entries(parsed as Record<string, unknown>)
  const rawVersion = (parsed as Record<string, unknown>).version
  const version = rawVersion === undefined ? CONFIG_VERSION : rawVersion
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0 || version > 255) {
    throw new Error(INVALID_FORMAT)
  }
  if (version !== CONFIG_VERSION) throw new Error(UNSUPPORTED_VERSION)
  return { version, sections: new Map(entries.filter(([key]) => key !== 'version')) }
}

/**
 * `version` 在前、其余段按键排序——对齐 Rust 的结构体字段顺序 + `BTreeMap`。
 *
 * 顺序对齐不是洁癖：同一个 `config.json` 会被桌面宿主和 Node 宿主轮流写，两边排序不一致时
 * 每次换宿主都会把整份文件重排一遍，用户拿 diff 根本看不出这次改了什么。
 *
 * 用 `Object.fromEntries` 而不是逐键赋值：`obj['__proto__'] = v` 会触发原型 setter 而不是建一个
 * 自有属性，配置文件里恰好有这么一个顶层键时，那一段会静默消失。
 */
function serializeConfig(config: WebAgentConfig): string {
  const ordered = Object.fromEntries([
    ['version', config.version] as const,
    ...[...config.sections.entries()].sort(([left], [right]) => (left < right ? -1 : 1)),
  ])
  return JSON.stringify(ordered, null, 2)
}
