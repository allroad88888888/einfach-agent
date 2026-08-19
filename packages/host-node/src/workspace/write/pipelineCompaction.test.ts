// 端到端验证 pipeline.ts 里的 compaction seam：只在 append + exclusivePathLock 命中索引路径时
// 才跑，跑起来会真的改变落盘内容，失败时整条写入按设计拒绝。压实本身的算法细节见
// compactionRules.test.ts / compaction.test.ts，这里只管「seam 接对了没有」。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWriteFixture, type WriteFixture } from './pipeline.testHarness'
import { INDEX_COMPACT_MAX_BYTES, INDEX_COMPACT_MIN_BYTES } from './limits'

let fixture: WriteFixture
let indexRoot: string

beforeEach(async () => {
  fixture = await createWriteFixture()
  indexRoot = join(fixture.root, '.webAgent-archive', 'index')
  await mkdir(indexRoot, { recursive: true })
})

afterEach(async () => {
  await fixture.cleanup()
})

/** count 条共用同一 conversationId/runId 的 runs 记录，体量必超下限，压实后只剩 1 条。 */
function oversizedRunsIndex(count: number): string {
  const filler = 'x'.repeat(700)
  let text = ''
  for (let status = 0; status < count; status += 1) {
    text += `${JSON.stringify({ conversationId: 'c', runId: 'r', status, summary: filler })}\n`
  }
  return text
}

describe('写入流水线里的归档 compaction 位', () => {
  it('append + exclusivePathLock 命中索引路径时，先压实旧内容再接上新内容', async () => {
    await writeFile(join(indexRoot, 'runs.jsonl'), oversizedRunsIndex(220))

    const result = await fixture.write({
      path: '.webAgent-archive/index/runs.jsonl',
      content: `${JSON.stringify({ conversationId: 'c', runId: 'r', status: 220 })}\n`,
      mode: 'append',
      exclusivePathLock: true,
    })

    expect(result.ok).toBe(true)
    const records = (await readFile(join(indexRoot, 'runs.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    // 旧的 220 条压成 1 条（key 相同，只留最新），加上这次追加的新一条 = 2 条。
    expect(records).toHaveLength(2)
    expect(records[0].status).toBe(219)
    expect(records[1].status).toBe(220)
  })

  it('不带 exclusivePathLock 就不压实，哪怕路径和体量都命中', async () => {
    const oversized = oversizedRunsIndex(220)
    await writeFile(join(indexRoot, 'runs.jsonl'), oversized)

    const result = await fixture.write({
      path: '.webAgent-archive/index/runs.jsonl',
      content: 'tail\n',
      mode: 'append',
    })

    expect(result.ok).toBe(true)
    expect(await readFile(join(indexRoot, 'runs.jsonl'), 'utf8')).toBe(`${oversized}tail\n`)
  })

  it('append 之外的模式即便带锁也不压实', async () => {
    await writeFile(join(indexRoot, 'runs.jsonl'), oversizedRunsIndex(220))

    const result = await fixture.write({
      path: '.webAgent-archive/index/runs.jsonl',
      content: 'replaced\n',
      mode: 'overwrite',
      exclusivePathLock: true,
    })

    expect(result.ok).toBe(true)
    expect(await readFile(join(indexRoot, 'runs.jsonl'), 'utf8')).toBe('replaced\n')
  })

  it('压实失败时整条写入按设计拒绝，新内容不会被追加（对齐 Rust：Err 折成 error_result）', async () => {
    const malformed = `{bad}\n${' '.repeat(INDEX_COMPACT_MIN_BYTES)}`
    await writeFile(join(indexRoot, 'skills.jsonl'), malformed)

    const result = await fixture.write({
      path: '.webAgent-archive/index/skills.jsonl',
      content: `${JSON.stringify({ skillId: 'new' })}\n`,
      mode: 'append',
      exclusivePathLock: true,
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('invalid JSON')
    expect(await readFile(join(indexRoot, 'skills.jsonl'), 'utf8')).toBe(malformed)
  })

  it('索引超过压实上限时整条写入被拒，理由指向人工处理', async () => {
    const oversized = 'x'.repeat(INDEX_COMPACT_MAX_BYTES + 1024)
    await writeFile(join(indexRoot, 'agents.jsonl'), oversized)

    const result = await fixture.write({
      path: '.webAgent-archive/index/agents.jsonl',
      content: 'tail\n',
      mode: 'append',
      exclusivePathLock: true,
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe(
      `agents index exceeds automatic compaction limit of ${INDEX_COMPACT_MAX_BYTES} bytes`,
    )
    expect(await readFile(join(indexRoot, 'agents.jsonl'), 'utf8')).toBe(oversized)
  })

  it('不匹配索引命名的归档文件即便带锁也不压实，只是普通追加', async () => {
    const eventsDir = join(fixture.root, '.webAgent-archive', 'conversations', 'c', 'runs', 'r')
    await mkdir(eventsDir, { recursive: true })
    const malformed = `event\n${' '.repeat(INDEX_COMPACT_MIN_BYTES)}`
    await writeFile(join(eventsDir, 'events.jsonl'), malformed)

    const result = await fixture.write({
      path: '.webAgent-archive/conversations/c/runs/r/events.jsonl',
      content: 'tail\n',
      mode: 'append',
      exclusivePathLock: true,
    })

    expect(result.ok).toBe(true)
    expect(await readFile(join(eventsDir, 'events.jsonl'), 'utf8')).toBe(`${malformed}tail\n`)
  })
})
