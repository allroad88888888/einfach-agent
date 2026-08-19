import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'
import { maybeCompactSubagentIndex } from './compaction'
import { INDEX_COMPACT_MAX_BYTES, INDEX_COMPACT_MIN_BYTES } from './limits'

let workspace: TempWorkspace
let indexRoot: string

beforeEach(async () => {
  workspace = await createTempWorkspace()
  indexRoot = join(workspace.root, '.webAgent-archive', 'index')
  await mkdir(indexRoot, { recursive: true })
})

afterEach(async () => {
  await workspace.cleanup()
})

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  )
}

/** count 条共用同一 conversationId/runId 的 runs 记录，体量必超下限，压实后只剩 1 条。 */
function oversizedRunsIndex(count: number): string {
  const filler = 'x'.repeat(700)
  let text = ''
  for (let status = 0; status < count; status += 1) {
    text += `${JSON.stringify({ conversationId: 'c', runId: 'r', status, summary: filler })}\n`
  }
  return text
}

/** count 条各不相同 skillId 的记录，压实不会去重掉任何一条，体量保持在下限之上。 */
function distinctSkillsIndex(count: number): string {
  const filler = 'x'.repeat(700)
  let text = ''
  for (let index = 0; index < count; index += 1) {
    text += `${JSON.stringify({ skillId: `s${index}`, summary: filler })}\n`
  }
  return text
}

describe('maybeCompactSubagentIndex —— 只压三种归档索引', () => {
  it('不匹配的路径原样跳过，即便内容超限又损坏（events.jsonl 永不参与压实）', async () => {
    const eventsDir = join(workspace.root, '.webAgent-archive', 'conversations', 'c', 'runs', 'r')
    await mkdir(eventsDir, { recursive: true })
    const events = join(eventsDir, 'events.jsonl')
    const malformed = `event\n${' '.repeat(INDEX_COMPACT_MIN_BYTES)}`
    await writeFile(events, malformed)
    await expect(maybeCompactSubagentIndex(events)).resolves.toBeUndefined()
    expect(await readFile(events, 'utf8')).toBe(malformed)
  })

  it('文件不存在直接跳过，不抛错', async () => {
    await expect(maybeCompactSubagentIndex(join(indexRoot, 'runs.jsonl'))).resolves.toBeUndefined()
  })

  it('体量小于下限不压，文件原样不动', async () => {
    const target = join(indexRoot, 'skills.jsonl')
    const small = `${JSON.stringify({ skillId: 's1' })}\n`
    await writeFile(target, small)
    await maybeCompactSubagentIndex(target)
    expect(await readFile(target, 'utf8')).toBe(small)
  })
})

describe('maybeCompactSubagentIndex —— 压实与 marker', () => {
  it('超过下限就压：同 key 只留最新一条，并留下节流 marker（对齐 Rust 的压实用例）', async () => {
    const target = join(indexRoot, 'runs.jsonl')
    const text = oversizedRunsIndex(220)
    expect(Buffer.byteLength(text)).toBeGreaterThan(INDEX_COMPACT_MIN_BYTES)
    await writeFile(target, text)

    await maybeCompactSubagentIndex(target)

    const records = (await readFile(target, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(records).toHaveLength(1)
    expect(records[0].status).toBe(219)
    expect(await exists(join(indexRoot, '.runs.compact-at'))).toBe(true)
  })

  it('压实走共享 atomicWrite，不留临时文件', async () => {
    const target = join(indexRoot, 'runs.jsonl')
    await writeFile(target, oversizedRunsIndex(220))
    await maybeCompactSubagentIndex(target)
    const leftovers = (await readdir(indexRoot)).filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  it('节流窗口内的第二次调用是纯粹的 no-op——连文件都不读', async () => {
    const target = join(indexRoot, 'skills.jsonl')
    await writeFile(target, distinctSkillsIndex(220))
    await maybeCompactSubagentIndex(target)
    const afterFirst = await readFile(target, 'utf8')
    // 全部 key 互不相同，压实不会去重掉任何一条，体量仍在下限之上——第二次调用不会因为
    // 「体量太小」提前短路，真要走到读文件那一步才会暴露下面这个损坏内容。
    expect(Buffer.byteLength(afterFirst)).toBeGreaterThan(INDEX_COMPACT_MIN_BYTES)

    await writeFile(target, `${afterFirst}{bad json`)
    await expect(maybeCompactSubagentIndex(target)).resolves.toBeUndefined()
    expect(await readFile(target, 'utf8')).toBe(`${afterFirst}{bad json`)
  })

  it('throttleMs:0 模拟节流窗口已过期，第二次调用照常再压一遍', async () => {
    const target = join(indexRoot, 'skills.jsonl')
    await writeFile(target, distinctSkillsIndex(220))
    await maybeCompactSubagentIndex(target, { throttleMs: 0 })

    const updated = `${JSON.stringify({ skillId: 's0', summary: 'updated' })}\n`
    await writeFile(target, `${await readFile(target, 'utf8')}${updated}`)
    await maybeCompactSubagentIndex(target, { throttleMs: 0 })

    const records = (await readFile(target, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(records).toHaveLength(220)
    expect(records.find((record) => record.skillId === 's0')?.summary).toBe('updated')
  })
})

describe('maybeCompactSubagentIndex —— 超限与失败', () => {
  it('超过上限直接拒绝，要求人工处理，文件不改动', async () => {
    const target = join(indexRoot, 'agents.jsonl')
    const text = 'x'.repeat(INDEX_COMPACT_MAX_BYTES + 1024)
    await writeFile(target, text)
    await expect(maybeCompactSubagentIndex(target)).rejects.toThrow(
      `agents index exceeds automatic compaction limit of ${INDEX_COMPACT_MAX_BYTES} bytes`,
    )
    expect(await readFile(target, 'utf8')).toBe(text)
  })

  it('压实失败（损坏的 JSON）时索引原样保留，不是半份新内容（对齐 Rust）', async () => {
    const target = join(indexRoot, 'skills.jsonl')
    const malformed = `{bad}\n${' '.repeat(INDEX_COMPACT_MIN_BYTES)}`
    await writeFile(target, malformed)
    await expect(maybeCompactSubagentIndex(target)).rejects.toThrow(/invalid JSON/)
    expect(await readFile(target, 'utf8')).toBe(malformed)
  })
})
