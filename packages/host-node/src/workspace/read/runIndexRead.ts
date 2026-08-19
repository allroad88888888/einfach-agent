// `read_workspace_run_index_page`：子 Agent 归档 run index 的尾向前分页读
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_read_run_index.rs（已随 T1 删除）的
// `read_workspace_run_index_page_blocking`。读的是固定路径 `.webAgent-archive/index/runs.jsonl`
// （`RUNS_INDEX_PATH`，见 limits.ts）——这条命令**没有** `path` 入参，与 `read_workspace_file`
// 不同，也因此没有 `allow_external_paths`：目标路径不是调用方给的，谈不上「允许读到根外」。
//
// 【游标形态：`{snapshot}:{beforeIndex}`】
// `before` 是「下一页从这个下标（不含）往前找」的 0-based 边界，不是行号。首次调用不传
// cursor 时 `before = allLines.length`（从最后一行开始往前找）。分页在 `parseRunIndexCursor`
// 里用 `lastIndexOf(':')` 切成两段——理由与 Rust 的 `rsplit_once(':')` 一致：snapshot 段本身
// （`v1-<len>-<16 位 hex>`）不含冒号，找最后一个冒号和找第一个等价，但防御性写法与 Rust 对齐。
// 非法游标（找不到冒号 / 版本前缀不是 `v1-` / before 段不是纯数字）一律
// `run index cursor is invalid; refresh history`（版本不对是单独一条
// `run index cursor version is unsupported; refresh history`）。**不能用 `Number()` 或
// `parseInt()` 松弛地解析 before**：JS 的 `Number('12abc')` 是 `NaN`（还好），但
// `parseInt('12abc', 10)` 是 `12`（会静默接受非法游标），而 Rust 的 `usize::parse` 要求整段
// 都是数字，所以这里手写 `/^\d+$/` 校验，行为与 Rust 逐字对齐。
//
// 【snapshot：证明「基于同一版文件」，不要求跨 Rust/Node 位串相同】
// Rust 用 `DefaultHasher`（SipHash13，固定种子 0,0）对整份字节做哈希，格式
// `v1-{byteLen}-{hash:016x}`。Node 没有内建 SipHash，这里改用 `sha256` 的前 16 位 hex 代替
// ——**刻意没有照搬 Rust 的具体哈希算法**：snapshot 只在同一个宿主内部「铸造 cursor」与
// 「验证 cursor」，Rust 桌面端与 Node 宿主是两个互不打游标交道的进程（前者服务 Tauri 壳，
// 后者服务浏览器/CLI），不存在跨宿主校验同一个 cursor 的场景，因此只需要「同样字节 ⇒ 同样
// snapshot，不同字节（含长度变化）⇒ 大概率不同 snapshot」这条自洽性质，不需要位串一致。
// 格式（`v1-<字节数>-<16 位 hex>`）保持一致，便于将来如果真要对拍时能一眼看出结构对应。
// cursor 携带的 snapshot 与本次读到的 snapshot 不一致 → `run index changed while paging;
// refresh history`（覆盖「追加写入」与「compact 替换整个文件」两种改动，测试见
// runIndexRead.test.ts）。cursor 里的 before 大于当前总行数（文件被 compact 变短，长度还
// 恰好换算出同一个 hex，理论上极小概率但仍需处理）→ `run index cursor is out of range;
// refresh history`，这条判定与 snapshot 判定分开写，跟 Rust 逐行对应。
//
// 【JSONL 行切分：没有复用 W2 的 lineBoundaries，自己写了一份】
// W2 的 `lineBoundaries`（linesRead.ts 私有）复刻的是 `str::split_inclusive('\n')`——它要保留
// 每行的换行符本身，服务于「按字节精确定位续读点」这个不同的问题。这里对齐的是 Rust 的
// `str::lines()`：按 `\n` 切分、每行再去掉可选的尾随 `\r`、且**字符串末尾恰好一个换行符时
// 不产生多余的空尾行**（`"a\nb\n".lines()` 是 2 行，不是 3 行）；空文件是 0 行，不是 1 行
// （JS 原生 `''.split('\n')` 给 `['']`，1 段，必须特判）。这两种切法在「文件不以换行符结尾」
// 与「文件中间的空行」上结果相同，只在「文件是否以换行符收尾」上分歧，所以没有复用价值，
// 直接写 `splitJsonlLines`。**末尾没有换行符的最后一行仍然算一行**（`"a\nb".lines()` 是
// `["a","b"]`），与 `.lines()` 文档「末尾换行符是可选的」一致。
//
// 【cursor 与 hasMore 的关系】`hasMore` 为 false 时结果里**没有 `cursor` 键**（不是
// `undefined`），与 Rust `has_more.then(|| ...)` + `#[serde(skip_serializing_if =
// "Option::is_none")]` 的组合行为一致：到了文件开头，没有更早内容可续。

import { readFile, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  errorText,
  resolveExistingWorkspacePath,
  resolveWorkspaceRoot,
  toSlashPath,
} from '../common'
import { decodeUtf8, rejectBinaryBytes } from './content'
import {
  DEFAULT_RUN_INDEX_PAGE_RECORDS,
  MAX_RUN_INDEX_BYTES,
  MAX_RUN_INDEX_PAGE_RECORDS,
  RUNS_INDEX_PATH,
  normalizePositive,
} from './limits'
import type { ReadWorkspaceRunIndexPageResult, WorkspaceJsonlLine } from './types'
import type { NodeHostInvokeOptions } from '../../hostOptions'
import type { NodeHostCommandHandler } from '../../routeTable'

const CURSOR_VERSION_PREFIX = 'v1-'
const INVALID_CURSOR_MESSAGE = 'run index cursor is invalid; refresh history'

/** 见 W1/W2 施工须知：判「传没传」只看值，不用 `'key' in args`（HTTP 传输会丢 undefined 键）。 */
function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

function nonNegativeIntegerArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/** `v1-<字节数>-<16 位小写 hex>`。算法选择理由见文件头。 */
function runIndexSnapshot(bytes: Buffer): string {
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  return `${CURSOR_VERSION_PREFIX}${bytes.length}-${digest}`
}

function parseRunIndexCursor(cursor: string): { snapshot: string; before: number } {
  const separator = cursor.lastIndexOf(':')
  if (separator < 0) throw new Error(INVALID_CURSOR_MESSAGE)
  const snapshot = cursor.slice(0, separator)
  if (!snapshot.startsWith(CURSOR_VERSION_PREFIX)) {
    throw new Error('run index cursor version is unsupported; refresh history')
  }
  const beforeText = cursor.slice(separator + 1)
  if (!/^\d+$/.test(beforeText)) throw new Error(INVALID_CURSOR_MESSAGE)
  const before = Number(beforeText)
  if (!Number.isSafeInteger(before)) throw new Error(INVALID_CURSOR_MESSAGE)
  return { snapshot, before }
}

/**
 * 等价 Rust `str::lines()`。见文件头「JSONL 行切分」。
 */
function splitJsonlLines(content: string): string[] {
  if (content === '') return []
  const parts = content.split('\n')
  if (content.endsWith('\n')) parts.pop()
  return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

async function statRunIndex(absolutePath: string, displayPath: string): Promise<Stats> {
  try {
    return await stat(absolutePath)
  } catch (error) {
    throw new Error(`file \`${displayPath}\` is not accessible: ${errorText(error)}`)
  }
}

function rejectOversizedRunIndex(byteLength: number): void {
  if (byteLength > MAX_RUN_INDEX_BYTES) {
    throw new Error(
      `run index exceeds the ${MAX_RUN_INDEX_BYTES} byte safety limit; compact the index first`,
    )
  }
}

/**
 * 从 `allLines[0, before)` 往前找非空白行，最多 `maxRecords` 条。
 *
 * 返回的 `nextBefore` 就是下一页要用的 `before`：等价 Rust 里那个在循环体内每轮都刷新、
 * 循环体外才读取的 `next_before`——它指向「这一轮刚处理过的下标」，所以下一页的
 * `(0..nextBefore)` 天然不会重复它。`before === 0`（上一页已经到头）时循环一次都不跑，
 * `nextBefore` 保持初始值 `before`，与 Rust 空区间时 `next_before` 原地不动一致。
 */
function collectRunIndexPage(
  allLines: string[],
  before: number,
  maxRecords: number,
): { lines: WorkspaceJsonlLine[]; nextBefore: number } {
  const lines: WorkspaceJsonlLine[] = []
  let nextBefore = before
  for (let index = before - 1; index >= 0; index -= 1) {
    nextBefore = index
    const line = allLines[index] as string
    if (line.trim() === '') continue
    lines.push({ lineNumber: index + 1, content: line })
    if (lines.length === maxRecords) break
  }
  return { lines, nextBefore }
}

/**
 * 入参是 snake_case（`read_workspace_run_index_page` 带 `rename_all = "snake_case"`，core 的
 * `toTauriRunIndexPageInput` 已经转好），**未经校验**，收窄在本函数内完成。
 */
export async function readWorkspaceRunIndexPage(
  args: Record<string, unknown>,
): Promise<ReadWorkspaceRunIndexPageResult> {
  const root = await resolveWorkspaceRoot(stringArg(args, 'workspace_root'))
  // RUNS_INDEX_PATH 是固定路径，不是调用方入参：没有 allowExternalPaths 可言。
  const { absolutePath } = await resolveExistingWorkspacePath(root, RUNS_INDEX_PATH, {
    allowExternalPaths: false,
  })
  // 错误消息里用绝对路径（Rust 的 `display_path`），返回值里的 path 是固定的根相对常量。
  // 这是 docs/node-host-issues.md 第 5 条记下的 Rust 侧问题，照搬不改。
  const displayPath = toSlashPath(absolutePath)

  const stats = await statRunIndex(absolutePath, displayPath)
  if (!stats.isFile()) throw new Error(`path \`${displayPath}\` is not a file`)
  rejectOversizedRunIndex(stats.size)

  let raw: Buffer
  try {
    raw = await readFile(absolutePath)
  } catch (error) {
    throw new Error(`failed to read \`${displayPath}\`: ${errorText(error)}`)
  }
  // 竞态兜底：stat 之后、读完之前文件可能被追加。
  rejectOversizedRunIndex(raw.length)
  rejectBinaryBytes(raw, displayPath)
  const content = decodeUtf8(raw, false, displayPath)

  const snapshot = runIndexSnapshot(raw)
  const allLines = splitJsonlLines(content)

  const cursorArg = stringArg(args, 'cursor')
  let before: number
  if (cursorArg !== undefined) {
    const parsed = parseRunIndexCursor(cursorArg)
    if (parsed.snapshot !== snapshot) {
      throw new Error('run index changed while paging; refresh history')
    }
    if (parsed.before > allLines.length) {
      throw new Error('run index cursor is out of range; refresh history')
    }
    before = parsed.before
  } else {
    before = allLines.length
  }

  const maxRecords = normalizePositive(
    nonNegativeIntegerArg(args, 'max_records'),
    DEFAULT_RUN_INDEX_PAGE_RECORDS,
    MAX_RUN_INDEX_PAGE_RECORDS,
  )

  const { lines, nextBefore } = collectRunIndexPage(allLines, before, maxRecords)
  const hasMore = allLines.slice(0, nextBefore).some((line) => line.trim() !== '')

  const result: ReadWorkspaceRunIndexPageResult = {
    path: RUNS_INDEX_PATH,
    lines,
    hasMore,
    snapshot,
  }
  if (hasMore) result.cursor = `${snapshot}:${nextBefore}`
  return result
}

/** `read_workspace_run_index_page` 的 handler 工厂。 */
export function createReadWorkspaceRunIndexPageHandler(
  _options: NodeHostInvokeOptions,
): NodeHostCommandHandler {
  return async (args) => readWorkspaceRunIndexPage(args)
}
