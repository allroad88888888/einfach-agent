import { describe, expect, it } from 'vitest'
import {
  compactSubagentIndex,
  indexCompactionMarkerPath,
  isCompactionThrottled,
  subagentIndexName,
} from './compactionRules'

describe('subagentIndexName', () => {
  it('识别三种归档索引文件', () => {
    expect(subagentIndexName('/ws/.webAgent-archive/index/runs.jsonl')).toBe('runs')
    expect(subagentIndexName('/ws/.webAgent-archive/index/skills.jsonl')).toBe('skills')
    expect(subagentIndexName('/ws/.webAgent-archive/index/agents.jsonl')).toBe('agents')
  })

  it('同目录的 events.jsonl 不算索引（这三个文件名之外的一律不压）', () => {
    expect(subagentIndexName('/ws/.webAgent-archive/index/events.jsonl')).toBeUndefined()
  })

  it('父目录名或祖父目录名对不上就不算，哪怕文件名相同', () => {
    expect(subagentIndexName('/ws/index/runs.jsonl')).toBeUndefined()
    expect(subagentIndexName('/ws/.webAgent-archive/other/runs.jsonl')).toBeUndefined()
    expect(subagentIndexName('/ws/runs.jsonl')).toBeUndefined()
  })
})

describe('indexCompactionMarkerPath', () => {
  it('是目标同目录的兄弟文件，带前导点（Rust 的 with_file_name 语义）', () => {
    expect(indexCompactionMarkerPath('/ws/.webAgent-archive/index/runs.jsonl', 'runs')).toBe(
      '/ws/.webAgent-archive/index/.runs.compact-at',
    )
  })
})

describe('isCompactionThrottled', () => {
  it('年龄小于节流窗口就算节流，够了就不算', () => {
    expect(isCompactionThrottled(100, 5 * 60 * 1000)).toBe(true)
    expect(isCompactionThrottled(5 * 60 * 1000, 5 * 60 * 1000)).toBe(false)
  })

  it('未来时间戳（负年龄）与非法年龄一律不算节流——读不准就压，不能无限期跳过', () => {
    expect(isCompactionThrottled(-1, 5 * 60 * 1000)).toBe(false)
    expect(isCompactionThrottled(Number.NaN, 5 * 60 * 1000)).toBe(false)
  })

  it('throttleMs 为 0 时任何非负年龄都不算节流', () => {
    expect(isCompactionThrottled(0, 0)).toBe(false)
    expect(isCompactionThrottled(10_000, 0)).toBe(false)
  })
})

describe('compactSubagentIndex', () => {
  it('按文档里的 key 去重：agents 用 conversationId+runId+path，skills 用 skillId（对齐 Rust 用例）', () => {
    const agents = [
      { conversationId: 'c', runId: 'r', path: 'root-01', status: 'running' },
      { conversationId: 'c', runId: 'r', path: 'root-02', status: 'running' },
      { conversationId: 'c', runId: 'r', path: 'root-01', status: 'completed' },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')
    const agentRecords = compactSubagentIndex('agents', agents)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(agentRecords).toHaveLength(2)
    expect(agentRecords[1].path).toBe('root-01')
    expect(agentRecords[1].status).toBe('completed')

    const skills = [
      { skillId: 's1', summary: 'old' },
      { skillId: 's2', summary: 'other' },
      { skillId: 's1', summary: 'new' },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')
    const skillRecords = compactSubagentIndex('skills', skills)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(skillRecords).toHaveLength(2)
    expect(skillRecords[1].skillId).toBe('s1')
    expect(skillRecords[1].summary).toBe('new')
  })

  it('runs 用 conversationId+runId，不同 conversation 下相同 runId 不会被误并', () => {
    const text = [
      { conversationId: 'a', runId: 'r', status: 1 },
      { conversationId: 'b', runId: 'r', status: 2 },
      { conversationId: 'a', runId: 'r', status: 3 },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')
    const records = compactSubagentIndex('runs', text)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(records).toHaveLength(2)
  })

  it('空行与首尾空白被忽略，不参与去重也不占位', () => {
    const text = '\n  \n{"skillId":"s1"}\n\n{"skillId":"s1","summary":"kept"}\n  \n'
    const records = compactSubagentIndex('skills', text)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(records).toEqual([{ skillId: 's1', summary: 'kept' }])
  })

  it('字段重排为 UTF-8 字节序——模拟 serde_json 无 preserve_order 时的 BTreeMap 输出', () => {
    const text = JSON.stringify({ runId: 'r', conversationId: 'c', status: 'z' })
    expect(compactSubagentIndex('runs', text)).toBe('{"conversationId":"c","runId":"r","status":"z"}\n')
  })

  it('整条不是 JSON 对象（数组/损坏）时报错并指出行号', () => {
    expect(() => compactSubagentIndex('skills', '["not", "an", "object"]')).toThrow(
      'skills index line 1: record must be an object',
    )
    expect(() => compactSubagentIndex('skills', '{bad json')).toThrow(/skills index line 1: invalid JSON/)
  })

  it('缺主键字段时报错，文案对齐 Rust', () => {
    expect(() => compactSubagentIndex('skills', '{"summary":"no id"}')).toThrow(
      'skills index line 1: record requires skillId',
    )
    expect(() => compactSubagentIndex('runs', '{"conversationId":"c"}')).toThrow(
      'runs index line 1: record requires conversationId and runId',
    )
    expect(() => compactSubagentIndex('agents', '{"conversationId":"c","runId":"r"}')).toThrow(
      'agents index line 1: record requires path',
    )
  })

  it('字段值是空白字符串时按缺失处理（trim 之后为空）', () => {
    expect(() => compactSubagentIndex('skills', '{"skillId":"   "}')).toThrow(
      'skills index line 1: record requires skillId',
    )
  })

  it('第二行才出错时，行号仍是它在原文件里的位置（空行也占行号）', () => {
    expect(() => compactSubagentIndex('skills', '\n{"summary":"missing id"}')).toThrow(
      'skills index line 2: record requires skillId',
    )
  })
})
