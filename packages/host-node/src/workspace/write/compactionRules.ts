// 归档索引压实的纯逻辑：路径判定、节流判定、JSONL 去重合并
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_write_compaction.rs 里不碰文件系统的那一半：
// `subagent_index_name`、节流判定、`compact_subagent_index`。IO（stat、读文件、重写、marker）
// 在 compaction.ts——分开是因为 W16/W17 对拍要拿这几条纯函数直接和 Rust 输入输出对表，
// 对拍不该顺带在磁盘上真建一份归档。
//
// 【JSON 重序列化为什么不能直接 JSON.stringify】
// `apps/desktop/Cargo.toml` 的 `serde_json = "1.0"` 没开 `preserve_order` 特性，于是
// `serde_json::Value::Object` 底层是 `BTreeMap<String, Value>`——重新序列化每条记录时，
// 字段按 key 的字节序**重排**，不是原始书写顺序。JS 的 `JSON.parse` → `JSON.stringify` 默认
// 保留插入序，如果直接用会让 Node 压实后的文件与 Rust 压实后的文件字段顺序不同（内容一样、
// 字节不同）——W16/W17 的跨语言对拍会在这里撞上。所以 `stableStringify` 自己按 key 重新排序。
// 用 `Buffer.compare` 而不是 JS 默认字符串比较（UTF-16 码元序）：理由与 node-host-issues.md
// 里 `changed_paths` 排序那条一致——增补平面字符在两种比较下顺序会反过来。这三个索引今天的
// 字段名全是 ASCII，实际不会触发分岔，但既然要对齐字节，就该按精确定义对齐，不能靠
// 「今天用不上」省掉这一步。

import { basename, dirname, join } from 'node:path'
import { Buffer } from 'node:buffer'
import { errorText } from '../common'

export type SubagentIndexName = 'runs' | 'skills' | 'agents'

const INDEX_ROOT_SEGMENT = '.webAgent-archive'
const INDEX_DIR_SEGMENT = 'index'

const INDEX_FILE_NAMES: Readonly<Record<string, SubagentIndexName>> = {
  'runs.jsonl': 'runs',
  'skills.jsonl': 'skills',
  'agents.jsonl': 'agents',
}

/**
 * 判断一个写入目标是不是子 Agent 归档索引——必须**恰好**是
 * `.webAgent-archive/index/{runs,skills,agents}.jsonl`。其余路径（含同目录下的
 * `events.jsonl`，以及 `.webAgent-archive/conversations/**\/events.jsonl`）一律不是，
 * 走普通写入路径，不参与压实。
 */
export function subagentIndexName(targetPath: string): SubagentIndexName | undefined {
  const name = INDEX_FILE_NAMES[basename(targetPath)]
  if (name === undefined) return undefined
  const parent = dirname(targetPath)
  if (basename(parent) !== INDEX_DIR_SEGMENT) return undefined
  if (basename(dirname(parent)) !== INDEX_ROOT_SEGMENT) return undefined
  return name
}

/** 节流 marker 的路径：目标文件的同目录兄弟，`.{name}.compact-at`（Rust 的 `with_file_name`）。 */
export function indexCompactionMarkerPath(targetPath: string, name: SubagentIndexName): string {
  return join(dirname(targetPath), `.${name}.compact-at`)
}

/**
 * marker 够新（年龄小于节流窗口）就该跳过这次压实。
 *
 * 未来时间戳（负年龄，时钟回拨或精度错配）与非法年龄一律**不算够新**——这与
 * `lockArchiveRules.ts` 的 `isArchiveLockStale` 反过来（那边未来时间戳判「不陈旧」，
 * 这里判「不节流」），但取舍同源：把一个读不准的年龄当成「刚压过」，代价是压实被无限期跳过。
 */
export function isCompactionThrottled(ageMs: number, throttleMs: number): boolean {
  if (!Number.isFinite(ageMs) || ageMs < 0) return false
  return ageMs < throttleMs
}

/**
 * 把一份 JSONL 索引压成「每个 key 只留最新一条」。
 *
 * key 的定义按索引种类而不同：skills 用 skillId；runs 用 conversationId+runId；
 * agents 用 conversationId+runId+path（同一次 run 里不同 agent 各有一条）。字段值必须是
 * trim 之后非空的字符串，否则整条压实失败——宁可拒绝也不要压出一份丢了主键的索引。
 *
 * 输出的行顺序按**最新一条出现的原始行号**排列（不是 key 首次出现的位置，也不是移到末尾），
 * 对齐 Rust 用 HashMap 收集、再按 `(index, _)` 排序的行为。
 */
export function compactSubagentIndex(name: SubagentIndexName, text: string): string {
  const latest = new Map<string, { index: number; record: Record<string, unknown> }>()
  const lines = text.split('\n')
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    if (line === '') continue
    const record = parseRecordLine(name, line, index)
    const key = recordKey(name, record, index)
    latest.set(key, { index, record })
  }
  const ordered = [...latest.values()].sort((a, b) => a.index - b.index)
  return ordered.map(({ record }) => `${stableStringify(record)}\n`).join('')
}

function parseRecordLine(name: SubagentIndexName, line: string, index: number): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    throw new Error(`${name} index line ${index + 1}: invalid JSON (${errorText(error)})`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${name} index line ${index + 1}: record must be an object`)
  }
  return parsed as Record<string, unknown>
}

function recordKey(name: SubagentIndexName, record: Record<string, unknown>, index: number): string {
  if (name === 'skills') {
    const skillId = field(record, 'skillId')
    if (skillId === undefined) throw new Error(`skills index line ${index + 1}: record requires skillId`)
    return skillId
  }
  const conversationId = field(record, 'conversationId')
  const runId = field(record, 'runId')
  if (conversationId === undefined || runId === undefined) {
    throw new Error(`${name} index line ${index + 1}: record requires conversationId and runId`)
  }
  if (name === 'runs') return `${conversationId}\0${runId}`
  const agentPath = field(record, 'path')
  if (agentPath === undefined) throw new Error(`agents index line ${index + 1}: record requires path`)
  return `${conversationId}\0${runId}\0${agentPath}`
}

/** 取一个字符串字段，trim 之后为空当作没有——对齐 Rust 的 `field` 闭包。 */
function field(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** 按 key 的 UTF-8 字节序重新序列化，模拟 serde_json 无 `preserve_order` 时的 BTreeMap 输出。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort(compareUtf8Bytes)
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function compareUtf8Bytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}
