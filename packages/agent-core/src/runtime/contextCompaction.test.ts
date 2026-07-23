// contextCompaction 单测 —— 重点在「压缩后序列仍然合法」。
// 协议不变量比压缩率重要得多：压得不够只是慢，压出孤儿 tool 是整个 run 报错。

import { describe, expect, it, vi } from 'vitest'
import type { AssistantItem, ModelItem, ModelToolCall, SystemItem, ToolItem, UserItem } from '@web-agent/ai'
import {
  COMPACTED_TOOL_RESULT_MARKER,
  compactContext,
  estimateItemsTokens,
  estimateItemsTokensUpperBound,
  estimateTokensFromText,
} from './contextCompaction'

// ── 构造 helper ─────────────────────────────────────────────────────────────

function system(content = '你是一个 agent'): SystemItem {
  return { role: 'system', content }
}

function user(content: string): UserItem {
  return { role: 'user', content }
}

function assistant(content: string | null): AssistantItem {
  return { role: 'assistant', content }
}

function toolCall(id: string, name: string, args: Record<string, unknown> = {}): ModelToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

function assistantWithCalls(calls: ModelToolCall[], content: string | null = null): AssistantItem {
  return { role: 'assistant', content, tool_calls: calls }
}

function toolResult(callId: string, content: string): ToolItem {
  return { role: 'tool', tool_call_id: callId, content }
}

// 造一段「够大」的工具结果正文（默认头 200 + 尾 100，必须远超它才压得动）。
function bigPayload(tag: string, size = 4000): string {
  return JSON.stringify({ ok: true, tag, blob: 'x'.repeat(size) })
}

function bigErrorPayload(tag: string, size = 4000): string {
  return JSON.stringify({ error: `${tag} failed`, detail: 'y'.repeat(size) })
}

// ── 协议校验器（本文件的核心断言）─────────────────────────────────────────
// OpenAI 兼容接口的硬要求：每条 role:'tool' 必须紧跟在「声明了同名 tool_call_id 的 assistant」
// 之后的 tool 串里。用状态机严格校验：
//   遇 assistant(tool_calls) → 打开一个 id 集合；
//   遇 tool → 其 id 必须在当前打开的集合里，命中即消费掉（防重复回填）；
//   遇其它 role → 关闭集合（此后再出现 tool 即为孤儿）。
function assertNoOrphanToolMessages(items: readonly ModelItem[]): void {
  let openIds: Set<string> | undefined

  items.forEach((item, index) => {
    if (item.role === 'tool') {
      expect(
        openIds?.has(item.tool_call_id),
        `孤儿 tool 结果 @${index}（tool_call_id=${item.tool_call_id}）—— 对应的 assistant.tool_calls 不见了`,
      ).toBe(true)
      openIds?.delete(item.tool_call_id)
      return
    }
    if (item.role === 'assistant' && item.tool_calls && item.tool_calls.length > 0) {
      openIds = new Set(item.tool_calls.map((call) => call.id))
      return
    }
    openIds = undefined
  })
}

function toolCallIdsIn(items: readonly ModelItem[]): string[] {
  return items.flatMap((item) =>
    item.role === 'assistant' && item.tool_calls ? item.tool_calls.map((call) => call.id) : [],
  )
}

function toolResultIdsIn(items: readonly ModelItem[]): string[] {
  return items.flatMap((item) => (item.role === 'tool' ? [item.tool_call_id] : []))
}

function isCompactedContent(content: string): boolean {
  const parsed: unknown = JSON.parse(content)
  return typeof parsed === 'object' && parsed !== null && COMPACTED_TOOL_RESULT_MARKER in parsed
}

// ── 场景构造：N 轮「user → assistant(tool_calls) → tool 结果 → assistant 文本」──
function buildConversation(turns: number, callsPerTurn = 1): ModelItem[] {
  const items: ModelItem[] = [system()]
  for (let t = 0; t < turns; t += 1) {
    items.push(user(`第 ${t} 轮的问题`))
    const calls = Array.from({ length: callsPerTurn }, (_, c) => toolCall(`call-${t}-${c}`, `tool_${c}`))
    items.push(assistantWithCalls(calls))
    for (const call of calls) items.push(toolResult(call.id, bigPayload(`${call.id}`)))
    items.push(assistant(`第 ${t} 轮的回答`))
  }
  return items
}

// ===========================================================================

describe('estimateTokensFromText', () => {
  it('空串为 0，CJK 与 ASCII 分别按 1.8 / 4 折算', () => {
    expect(estimateTokensFromText('')).toBe(0)
    expect(estimateTokensFromText('abcd')).toBe(1)
    expect(estimateTokensFromText('中文中文')).toBe(Math.ceil(4 / 1.8))
  })

  it('estimateItemsTokens 等于逐条 JSON.stringify 后求和（与 modelRun 同口径）', () => {
    const items: ModelItem[] = [system('sys'), user('hi'), assistant('yo')]
    const expected = items.reduce((sum, item) => sum + estimateTokensFromText(JSON.stringify(item)), 0)
    expect(estimateItemsTokens(items)).toBe(expected)
  })
})

describe('compactContext —— 不超预算', () => {
  it('未超预算时原样返回同一个数组引用，且不标记 compacted', () => {
    const items = buildConversation(2)
    const result = compactContext(items, { maxTokens: 1_000_000 })

    expect(result.items).toBe(items)
    expect(result.compacted).toBe(false)
    expect(result.withinBudget).toBe(true)
    expect(result.summarizedToolResults).toBe(0)
    expect(result.droppedItems).toBe(0)
  })

  it('reservedTokens 会从预算里扣掉，扣到不够时才触发压缩', () => {
    const items = buildConversation(4)
    const before = estimateItemsTokens(items)

    const loose = compactContext(items, { maxTokens: before + 100, reservedTokens: 0 })
    expect(loose.compacted).toBe(false)

    const tight = compactContext(items, { maxTokens: before + 100, reservedTokens: 500 })
    expect(tight.compacted).toBe(true)
    expect(tight.effectiveBudgetTokens).toBe(before + 100 - 500)
  })
})

describe('compactContext —— 超预算压缩', () => {
  it('优先摘要早期 tool 结果，对话主干完整保留', () => {
    const items = buildConversation(6)
    const before = estimateItemsTokens(items)
    const result = compactContext(items, { maxTokens: Math.floor(before / 2) })

    expect(result.compacted).toBe(true)
    expect(result.withinBudget).toBe(true)
    expect(result.summarizedToolResults).toBeGreaterThan(0)
    expect(result.droppedItems).toBe(0) // 光靠摘要就够了，不该动到丢弃级
    expect(result.estimatedTokensAfter).toBeLessThanOrEqual(result.effectiveBudgetTokens)

    // 主干（user + assistant 文本）一条不少
    for (let t = 0; t < 6; t += 1) {
      expect(result.items).toContainEqual(user(`第 ${t} 轮的问题`))
      expect(result.items).toContainEqual(assistant(`第 ${t} 轮的回答`))
    }
    assertNoOrphanToolMessages(result.items)
  })

  it('摘要占位保留工具名 / 成功失败 / 原始长度 / 头尾片段', () => {
    const items: ModelItem[] = [
      system(),
      user('第一轮'),
      assistantWithCalls([toolCall('c1', 'read_file'), toolCall('c2', 'run_task')]),
      toolResult('c1', bigPayload('alpha')),
      toolResult('c2', bigErrorPayload('beta')),
      assistant('好的'),
      user('第二轮'),
      assistant('收到'),
      user('第三轮'),
    ]
    const original = items[3] as ToolItem
    // 预算刻意选在「L1 摘要就够、够不着 L2 丢弃」的档位，好检查占位内容本身。
    const result = compactContext(items, { maxTokens: 500 })

    const compacted = result.items.filter((item): item is ToolItem => item.role === 'tool')
    expect(compacted).toHaveLength(2)
    expect(result.droppedItems).toBe(0)

    const first = JSON.parse(compacted[0].content) as Record<string, unknown>
    expect(first[COMPACTED_TOOL_RESULT_MARKER]).toBe(true)
    expect(first.tool).toBe('read_file')
    expect(first.status).toBe('ok')
    expect(first.chars).toBe(original.content.length)
    expect(first.head).toBe(original.content.slice(0, 200))
    expect(first.tail).toBe(original.content.slice(-100))

    const second = JSON.parse(compacted[1].content) as Record<string, unknown>
    expect(second.tool).toBe('run_task')
    expect(second.status).toBe('error') // {"error": ...} 被识别为失败
  })

  it('压缩后总量严格下降，且绝不把上下文压得更大', () => {
    const items = buildConversation(8, 2)
    const result = compactContext(items, { maxTokens: 200 })

    expect(result.estimatedTokensAfter).toBeLessThan(result.estimatedTokensBefore)
    expect(estimateItemsTokens(result.items)).toBe(result.estimatedTokensAfter)
  })

  it('对已压缩过的结果再压一次是幂等的（不二次包裹）', () => {
    const items = buildConversation(6)
    const once = compactContext(items, { maxTokens: 300 })
    const twice = compactContext(once.items, { maxTokens: 300 })

    const onceTools = once.items.filter((item): item is ToolItem => item.role === 'tool')
    const twiceTools = twice.items.filter((item): item is ToolItem => item.role === 'tool')
    expect(twiceTools.map((item) => item.content)).toEqual(onceTools.map((item) => item.content))
    for (const item of twiceTools) {
      const parsed = JSON.parse(item.content) as Record<string, unknown>
      expect(parsed[COMPACTED_TOOL_RESULT_MARKER]).toBe(true)
      // head 本身不该是又一层占位（否则说明被套娃压了两次）
      expect(String(parsed.head).includes(`"${COMPACTED_TOOL_RESULT_MARKER}"`)).toBe(false)
    }
  })

  it('短小的 tool 结果不压（占位比原文还长时跳过）', () => {
    const items: ModelItem[] = [
      system(),
      user('a'),
      assistantWithCalls([toolCall('c1', 'ping')]),
      toolResult('c1', '{"ok":true}'),
      assistant('done'),
      user('b'),
      assistant('done2'),
      user('c'),
    ]
    const result = compactContext(items, { maxTokens: 0 })
    const remaining = result.items.filter((item): item is ToolItem => item.role === 'tool')
    // 要么整组被丢（合法），要么保留原文；绝不会被替换成更长的占位。
    for (const item of remaining) expect(item.content).toBe('{"ok":true}')
  })
})

describe('compactContext —— tool-call 配对完整性（CC3）', () => {
  it('任何预算下都不产生孤儿 tool 结果', () => {
    const items = buildConversation(10, 3)
    const budgets = [0, 1, 50, 200, 800, 2_000, 10_000, 100_000]

    for (const maxTokens of budgets) {
      const result = compactContext(items, { maxTokens })
      assertNoOrphanToolMessages(result.items)

      // 反向：保留下来的 tool 结果，其 id 必须在保留下来的 assistant.tool_calls 里
      const declared = new Set(toolCallIdsIn(result.items))
      for (const id of toolResultIdsIn(result.items)) {
        expect(declared.has(id), `预算 ${maxTokens}：tool 结果 ${id} 的 assistant 被丢了`).toBe(true)
      }
    }
  })

  it('丢弃 tool 组时整组同生共死（assistant 与其全部 tool 结果一起消失）', () => {
    const items = buildConversation(8, 3)
    const result = compactContext(items, { maxTokens: 150 })

    expect(result.droppedItems).toBeGreaterThan(0)

    // 逐组核对：某组的 assistant 在 → 其结果条数不变；不在 → 其结果一条不剩。
    for (let t = 0; t < 8; t += 1) {
      const ids = [0, 1, 2].map((c) => `call-${t}-${c}`)
      const assistantKept = result.items.some(
        (item) => item.role === 'assistant' && item.tool_calls?.some((call) => call.id === ids[0]),
      )
      const keptResults = toolResultIdsIn(result.items).filter((id) => ids.includes(id))
      if (assistantKept) {
        expect(keptResults.sort()).toEqual([...ids].sort())
      } else {
        expect(keptResults).toEqual([])
      }
    }
  })

  it('连续多组 tool_calls（中间没有 user 分隔）也能正确切组', () => {
    const items: ModelItem[] = [
      system(),
      user('干活'),
      assistantWithCalls([toolCall('a1', 'step1')]),
      toolResult('a1', bigPayload('a1')),
      assistantWithCalls([toolCall('b1', 'step2'), toolCall('b2', 'step3')]),
      toolResult('b1', bigPayload('b1')),
      toolResult('b2', bigPayload('b2')),
      assistantWithCalls([toolCall('c1', 'step4')]),
      toolResult('c1', bigPayload('c1')),
      assistant('搞定'),
      user('再来一轮'),
      assistant('好'),
      user('最后一句'),
    ]

    for (const maxTokens of [0, 100, 400, 1_500]) {
      const result = compactContext(items, { maxTokens })
      assertNoOrphanToolMessages(result.items)
      const declared = new Set(toolCallIdsIn(result.items))
      for (const id of toolResultIdsIn(result.items)) expect(declared.has(id)).toBe(true)
    }
  })

  it('ask_user 式「tool_calls 未被完全回填」的组不会被拆散', () => {
    // runToolLoop 暂停时会特意留一个 tool_call 不回填（等 resume 补），压缩不得试图裁掉它。
    const items: ModelItem[] = [
      system(),
      user('老问题'),
      assistantWithCalls([toolCall('t1', 'read_file'), toolCall('t2', 'ask_user_question')]),
      toolResult('t1', bigPayload('t1')), // t2 故意没有结果
      user('新问题'),
      assistant('好的'),
      user('最后一句'),
    ]
    const result = compactContext(items, { maxTokens: 60 })

    const askAssistant = result.items.find(
      (item) => item.role === 'assistant' && item.tool_calls?.some((call) => call.id === 't2'),
    )
    const t1Kept = toolResultIdsIn(result.items).includes('t1')
    // assistant 在 → t1 结果必须也在；assistant 不在 → t1 结果必须也不在。
    expect(t1Kept).toBe(askAssistant !== undefined)
    assertNoOrphanToolMessages(result.items)
  })
})

describe('compactContext —— 保护窗口与硬保护项', () => {
  it('system 条目在任何预算下都原样保留', () => {
    const items = buildConversation(6)
    for (const maxTokens of [0, 1, 100, 5_000]) {
      const result = compactContext(items, { maxTokens })
      expect(result.items[0]).toEqual(system())
      expect(result.items.filter((item) => item.role === 'system')).toHaveLength(1)
    }
  })

  it('最后一条 user 输入在任何预算下都原样保留', () => {
    const items = buildConversation(6)
    items.push(user('这是最新的、绝对不能动的问题'))

    for (const maxTokens of [0, 1, 100, 5_000]) {
      const result = compactContext(items, { maxTokens })
      const users = result.items.filter((item): item is UserItem => item.role === 'user')
      expect(users[users.length - 1]).toEqual(user('这是最新的、绝对不能动的问题'))
    }
  })

  it('默认保护最近 2 轮：最近轮次的 tool 结果在中等预算下不被摘要', () => {
    const items = buildConversation(6)
    const before = estimateItemsTokens(items)
    const result = compactContext(items, { maxTokens: Math.floor(before / 2) })

    // 最近两轮 = 第 4、5 轮，它们的 tool 结果应保持原文
    for (const turn of [4, 5]) {
      const kept = result.items.find(
        (item): item is ToolItem => item.role === 'tool' && item.tool_call_id === `call-${turn}-0`,
      )
      expect(kept).toBeDefined()
      expect(isCompactedContent(kept!.content)).toBe(false)
    }
    // 第 0 轮属于历史，应已被摘要
    const oldest = result.items.find(
      (item): item is ToolItem => item.role === 'tool' && item.tool_call_id === 'call-0-0',
    )
    expect(oldest).toBeDefined()
    expect(isCompactedContent(oldest!.content)).toBe(true)
  })

  it('keepRecentTurns 可调，调大后被摘要的历史更少', () => {
    const items = buildConversation(8)
    const budget = Math.floor(estimateItemsTokens(items) / 2)
    const keep2 = compactContext(items, { maxTokens: budget, keepRecentTurns: 2 })
    const keep6 = compactContext(items, { maxTokens: budget, keepRecentTurns: 6 })

    expect(keep6.summarizedToolResults).toBeLessThanOrEqual(keep2.summarizedToolResults)
    assertNoOrphanToolMessages(keep6.items)
  })

  it('历史全压完仍超预算时才动保护窗口内的 tool 结果（L4），且不丢窗口内条目', () => {
    // 只有一轮 —— 全部内容都在保护窗口里，唯一出路就是压窗口内的 tool 结果。
    const items: ModelItem[] = [
      system(),
      user('读个大文件'),
      assistantWithCalls([toolCall('c1', 'read_file')]),
      toolResult('c1', bigPayload('huge', 50_000)),
      assistant('读完了'),
    ]
    const result = compactContext(items, { maxTokens: 100 })

    expect(result.droppedItems).toBe(0) // 窗口内不丢条目
    expect(result.summarizedToolResults).toBe(1)
    expect(result.items).toHaveLength(items.length)
    expect(result.items).toContainEqual(user('读个大文件'))
    assertNoOrphanToolMessages(result.items)
  })
})

describe('compactContext —— 极端与退化输入', () => {
  it('预算为 0 时不死循环、不抛错，仍产出合法序列', () => {
    const items = buildConversation(12, 2)
    const result = compactContext(items, { maxTokens: 0 })

    assertNoOrphanToolMessages(result.items)
    expect(result.items.length).toBeGreaterThan(0)
    expect(result.items[0].role).toBe('system')
    expect(result.withinBudget).toBe(false) // 0 预算不可能达标，如实汇报
    expect(result.compacted).toBe(true)
  })

  it('负预算 / NaN 预算被夹到 0，不抛错', () => {
    const items = buildConversation(3)
    for (const maxTokens of [-100, Number.NaN]) {
      const result = compactContext(items, { maxTokens })
      expect(result.effectiveBudgetTokens).toBe(0)
      assertNoOrphanToolMessages(result.items)
    }
  })

  it('reservedTokens 超过 maxTokens 时预算夹到 0', () => {
    const items = buildConversation(3)
    const result = compactContext(items, { maxTokens: 100, reservedTokens: 5_000 })
    expect(result.effectiveBudgetTokens).toBe(0)
    assertNoOrphanToolMessages(result.items)
  })

  it('空数组 / 只有 system 的输入原样返回', () => {
    expect(compactContext([], { maxTokens: 0 }).items).toEqual([])
    const onlySystem: ModelItem[] = [system()]
    const result = compactContext(onlySystem, { maxTokens: 0 })
    expect(result.items).toEqual(onlySystem)
    expect(result.droppedItems).toBe(0)
  })

  it('没有任何 user 条目的退化输入不会崩，system 仍在', () => {
    const items: ModelItem[] = [
      system(),
      assistantWithCalls([toolCall('c1', 'x')]),
      toolResult('c1', bigPayload('c1')),
      assistant('结束'),
    ]
    const result = compactContext(items, { maxTokens: 10 })
    expect(result.items.some((item) => item.role === 'system')).toBe(true)
    assertNoOrphanToolMessages(result.items)
  })

  it('入参本身带孤儿 tool 时不会把问题放大（孤儿与前序单元同生共死）', () => {
    const items: ModelItem[] = [
      system(),
      user('问题'),
      toolResult('ghost', bigPayload('ghost')), // 前面没有任何 assistant.tool_calls
      assistant('回答'),
      user('最后一句'),
    ]
    const result = compactContext(items, { maxTokens: 0 })
    // 不要求修好非法入参，只要求：不新增孤儿、不抛错、硬保护项还在。
    expect(result.items.some((item) => item.role === 'system')).toBe(true)
    expect(result.items).toContainEqual(user('最后一句'))
  })

  it('不修改入参数组及其条目（纯函数）', () => {
    const items = buildConversation(6)
    const snapshot = JSON.parse(JSON.stringify(items)) as ModelItem[]
    compactContext(items, { maxTokens: 0 })
    expect(items).toEqual(snapshot)
  })
})

// 本模块原本只服务主循环（被摘要的多是 read_file / skill_read 这类读操作），后来也接进了
// 子 agent 循环，于是被摘要的对象里多了一类：嵌套 delegate_agent 回填的整棵子树结果。
// 对它说「需要完整内容请重新调用该工具」，模型照做就是重跑一整棵子 agent 子树 ——
// 非幂等、再烧一遍配额、归档写盘与危险工具副作用全部重来。占位文案必须按工具分叉。
describe('compactContext —— 摘要占位的重调建议按工具是否可安全重放分叉', () => {
  function noteOf(items: readonly ModelItem[], callId: string): string {
    const item = items.find((it) => it.role === 'tool' && it.tool_call_id === callId)
    if (!item || item.role !== 'tool') throw new Error(`找不到 tool 结果 ${callId}`)
    const parsed = JSON.parse(item.content) as { note?: string }
    return parsed.note ?? ''
  }

  // 同一段超大正文，只有工具名不同 —— 隔离出「文案随工具名分叉」这一个变量。
  function compactedWithTool(toolName: string): string {
    const items: ModelItem[] = [
      system(),
      user('第一轮'),
      assistantWithCalls([toolCall('c1', toolName)]),
      toolResult('c1', bigPayload('payload', 8000)),
      assistant('第一轮答复'),
      user('第二轮'),
      assistantWithCalls([toolCall('c2', 'read_file')]),
      toolResult('c2', bigPayload('recent', 8000)),
      user('第三轮'),
    ]
    const result = compactContext(items, { maxTokens: 1200, keepRecentTurns: 1 })
    expect(result.compacted).toBe(true)
    return noteOf(result.items, 'c1')
  }

  it('读类工具：建议重新调用（重调只是再读一次，代价可忽略）', () => {
    const note = compactedWithTool('read_file')
    expect(note).toContain('重新调用')
    expect(note).not.toContain('不要')
  })

  it('delegate_agent：绝不建议重新调用（重调 = 重跑一整棵子树，非幂等且烧配额）', () => {
    const note = compactedWithTool('delegate_agent')
    expect(note).toContain('不要')
    expect(note).toContain('副作用')
  })

  it('写类工具与高代价工具同样不建议重调（重放会二次改动 workspace）', () => {
    for (const toolName of ['write_file', 'apply_patch', 'shell_macos', 'run_task']) {
      expect(noteOfTool(toolName)).toContain('不要')
    }
    function noteOfTool(toolName: string): string {
      return compactedWithTool(toolName)
    }
  })
})

// ===========================================================================
// 预扫描粗筛（性能优化，行为必须逐字节等价）
// ===========================================================================
// compactContext 每轮无条件调用，第一步的 estimateItemsTokens 会逐条 JSON.stringify；子 agent
// 扇出执行时这会叠成几十次全量同步扫描 → 掉帧。粗筛用「只读 .length」的 token 上界先判一次
// 「肯定没超」，成立就跳过序列化。
//
// 本节的全部风险都压在一句话上：★ 粗筛必须是【上界】★。一旦它低估（返回值 < 精确值），
// 就会把「其实已超预算」的轮次判成「没超」→ 该压的不压 → 请求带着超预算的 messages 撞 400。
// 所以下面每个用例都围绕「上界性」与「判定结果不因粗筛而改变」来写。

describe('estimateItemsTokensUpperBound —— 上界性（粗筛的唯一安全前提）', () => {
  // 覆盖 JSON 序列化的各种代价形态：ASCII（1 倍）、CJK（不转义但 1/1.8 折算）、
  // 控制字符与孤立代理项（\uXXXX，6 倍膨胀 —— 最坏情形）、代理对、引号反斜杠（2 倍）。
  const fixtures: Array<[string, ModelItem[]]> = [
    ['空数组', []],
    ['只有 system', [system()]],
    ['纯 ASCII 会话', buildConversation(4)],
    ['CJK 密集', [system('中文系统提示'.repeat(50)), user('中文中文中文'.repeat(200))]],
    [
      '控制字符（6 倍转义膨胀，最坏情形）',
      [
        system(),
        user('读日志'),
        assistantWithCalls([toolCall('c1', 'read_file')]),
        toolResult('c1', '\u0001\u0002\u001f'.repeat(500)),
      ],
    ],
    [
      '孤立代理项（同样 6 倍膨胀）',
      [system(), user('x'), assistantWithCalls([toolCall('c1', 'read_file')]), toolResult('c1', '\ud800'.repeat(800))],
    ],
    ['引号与反斜杠（2 倍膨胀）', [system(), user('"\\'.repeat(600))]],
    ['代理对 emoji', [system(), user('🙂🎉'.repeat(400))]],
    ['null content + reasoning_content', [{ role: 'assistant', content: null, reasoning_content: '想了想'.repeat(80) }]],
    [
      '多 tool_calls',
      [
        system(),
        user('并行干活'),
        assistantWithCalls(
          Array.from({ length: 12 }, (_, i) => toolCall(`c${i}`, `tool_${i}`, { path: `/x/${i}`, deep: { a: [1, 2, 3] } })),
        ),
      ],
    ],
    ['空字符串 content', [system(''), user(''), assistant('')]],
  ]

  for (const [name, items] of fixtures) {
    it(`上界 >= 精确值：${name}`, () => {
      expect(estimateItemsTokensUpperBound(items)).toBeGreaterThanOrEqual(estimateItemsTokens(items))
    })
  }

  it('随机模糊测试：任意字符组合下上界都不低于精确值', () => {
    // 固定种子的 mulberry32 —— 可复现，不引入随机翻红。
    let seed = 0x9e3779b9
    const rand = (): number => {
      seed = (seed + 0x6d2b79f5) >>> 0
      let t = seed
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    // 刻意混入 JSON 转义会膨胀的字符类，否则全 ASCII 的样本对上界几乎没有约束力。
    const pool = ['a', 'Z', '0', ' ', '中', '文', '。', '"', '\\', '\n', '\u0001', '\u001f', '\ud800', '🙂']
    const randStr = (len: number): string =>
      Array.from({ length: len }, () => pool[Math.floor(rand() * pool.length)]).join('')

    for (let round = 0; round < 120; round += 1) {
      const items: ModelItem[] = [system(randStr(Math.floor(rand() * 40)))]
      const count = 1 + Math.floor(rand() * 6)
      for (let i = 0; i < count; i += 1) {
        const roll = rand()
        if (roll < 0.3) items.push(user(randStr(Math.floor(rand() * 200))))
        else if (roll < 0.5) items.push(assistant(rand() < 0.2 ? null : randStr(Math.floor(rand() * 200))))
        else if (roll < 0.75) {
          items.push(assistantWithCalls([toolCall(`c${i}`, randStr(6), { arg: randStr(30) })]))
        } else items.push(toolResult(`c${i}`, randStr(Math.floor(rand() * 400))))
      }
      const upper = estimateItemsTokensUpperBound(items)
      const exact = estimateItemsTokens(items)
      expect(upper, `第 ${round} 轮：上界 ${upper} < 精确值 ${exact}`).toBeGreaterThanOrEqual(exact)
    }
  })

  it('环状引用不会死循环，退化成 Infinity（逼调用方走精确路径）', () => {
    const cyclic = { role: 'user', content: 'hi' } as unknown as Record<string, unknown>
    cyclic.self = cyclic
    expect(estimateItemsTokensUpperBound([cyclic as unknown as ModelItem])).toBe(Number.POSITIVE_INFINITY)
    // 精确路径靠 stringForStats 的 try/catch 兜住，compactContext 整体仍不抛错。
    expect(() => compactContext([cyclic as unknown as ModelItem], { maxTokens: 10 })).not.toThrow()
  })

  it('带 toJSON 的值（序列化产物无从预估）退化成 Infinity 而不是猜一个数', () => {
    const withToJson = {
      role: 'user',
      content: 'x',
      at: new Date('2020-01-01T00:00:00.000Z'),
    } as unknown as ModelItem
    expect(estimateItemsTokensUpperBound([withToJson])).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('compactContext —— 粗筛不改变任何判定（关键临界值）', () => {
  // 每个 fixture 都要能把「粗筛低估」暴露出来，所以必须包含转义/CJK 这类高 token 密度的正文：
  // 纯 ASCII 下 raw 长度和精确 token 的比值本就接近 1/4，系数被改小也未必露馅。
  const fixtures: Array<[string, () => ModelItem[]]> = [
    ['纯 ASCII 会话', () => buildConversation(4)],
    [
      'CJK 密集（0.556 token/字符，远高于 ASCII 的 0.25）',
      () => [system('系统提示'), user('中文问题'.repeat(400)), assistant('中文回答'.repeat(400)), user('最后一句')],
    ],
    [
      '控制字符正文（1.5 token/字符 —— 粗筛系数的理论上限，最紧的一档）',
      () => [
        system(),
        user('读日志'),
        assistantWithCalls([toolCall('c1', 'read_file')]),
        toolResult('c1', '\u0001'.repeat(4000)),
        user('最后一句'),
      ],
    ],
    [
      '孤立代理项正文（同样打满 1.5 token/字符）',
      () => [
        system(),
        user('读二进制'),
        assistantWithCalls([toolCall('c1', 'read_file')]),
        toolResult('c1', '\ud800'.repeat(3000)),
        user('最后一句'),
      ],
    ],
    // 上面几档都还带着 JSON 骨架的富余（骨架字符实际只值 1/4 token，粗筛却按 1.5 算，
    // 于是每条 message 白送几十 token 的安全垫）。这一档刻意把正文体量拉到 5 万字符，
    // 把那点常数余量摊薄到可忽略 —— 于是断言直接压在 1.5 这个系数本身上：
    // 系数只要被调低千分之一，上界就会跌破精确值，本组用例立刻翻红。
    ['控制字符正文 · 极大体量（摊薄骨架余量，直接考验 1.5 这个系数）', () => [user('\u0001'.repeat(50_000))]],
  ]

  for (const [name, make] of fixtures) {
    // 「是否发生压缩」这件事必须【完全由精确值决定】：compactContext 未超预算时返回入参同一引用，
    // 超预算时必然新建数组 —— 于是 `items 引用是否被保留` 就是一个尖锐的、可判定的等价断言。
    it(`压不压完全由精确值决定，粗筛只影响算得快不快：${name}`, () => {
      const items = make()
      const exact = estimateItemsTokens(items)
      const upper = estimateItemsTokensUpperBound(items)
      expect(upper).toBeGreaterThanOrEqual(exact)

      for (const maxTokens of [0, 1, exact - 1, exact, exact + 1, upper, upper + 1]) {
        const result = compactContext(items, { maxTokens })
        const shouldSkip = exact <= Math.max(0, maxTokens || 0)
        expect(
          result.items === items,
          `预算 ${maxTokens}：精确值 ${exact}，应${shouldSkip ? '' : '不'}保留入参引用`,
        ).toBe(shouldSkip)
        // 未超预算的轮次一定不带 compacted 标记（超预算轮次压没压得动取决于内容，这里不断言）。
        if (shouldSkip) {
          expect(result.compacted).toBe(false)
          expect(result.withinBudget).toBe(true)
          expect(result.summarizedToolResults).toBe(0)
          expect(result.droppedItems).toBe(0)
        }
      }
    })

    // ★ 变异测试的靶心 ★ 预算刚好比精确值少 1 —— 这是「该压」的最小临界情形。
    // 只要粗筛的上界被改小到低于精确值（哪怕只低 1），它就会 <= 本预算而判定「肯定没超」，
    // 于是这一轮被漏压、入参引用被原样返回，本用例立刻翻红。
    it(`预算刚好差 1 时必须真的压（粗筛系数被改激进就会在这里翻红）：${name}`, () => {
      const items = make()
      const exact = estimateItemsTokens(items)
      expect(exact).toBeGreaterThan(1)

      const result = compactContext(items, { maxTokens: exact - 1 })
      expect(result.items, '粗筛漏压：本该走压缩路径却原样返回了入参').not.toBe(items)
      expect(result.estimatedTokensBefore).toBe(exact)
      expect(result.effectiveBudgetTokens).toBe(exact - 1)
    })

    it(`预算刚好等于精确值时不压（既不该多压，也不该少压）：${name}`, () => {
      const items = make()
      const exact = estimateItemsTokens(items)
      const result = compactContext(items, { maxTokens: exact })
      expect(result.items).toBe(items)
      expect(result.compacted).toBe(false)
      expect(result.withinBudget).toBe(true)
    })
  }
})

describe('compactContext —— 粗筛跳过路径与精确路径的返回值完全一致', () => {
  it('两条路径逐字段相同（字段集合、取值、items 引用）', () => {
    const items = buildConversation(3)
    const exact = estimateItemsTokens(items)
    const upper = estimateItemsTokensUpperBound(items)
    // 前提：两个预算确实落在不同的代码路径上，否则本用例是空转。
    expect(upper).toBeGreaterThan(exact)

    const skipped = compactContext(items, { maxTokens: upper }) // 粗筛判定「肯定没超」→ 跳过序列化
    const precise = compactContext(items, { maxTokens: exact }) // 粗筛失败 → 走精确估算后判定未超

    // 字段集合必须一致 —— 防止「跳过路径少填了某个字段」。
    expect(Object.keys(skipped).sort()).toEqual(Object.keys(precise).sort())

    expect(skipped.items).toBe(items)
    expect(precise.items).toBe(items)
    expect(skipped.compacted).toBe(precise.compacted)
    expect(skipped.withinBudget).toBe(precise.withinBudget)
    expect(skipped.summarizedToolResults).toBe(precise.summarizedToolResults)
    expect(skipped.droppedItems).toBe(precise.droppedItems)
    // token 数是「同一个口径的同一个值」，只是跳过路径算得晚。
    expect(skipped.estimatedTokensBefore).toBe(exact)
    expect(skipped.estimatedTokensAfter).toBe(exact)
    expect(skipped.estimatedTokensBefore).toBe(precise.estimatedTokensBefore)
    expect(skipped.estimatedTokensAfter).toBe(precise.estimatedTokensAfter)
    // 唯一允许不同的字段就是预算本身（是入参，不是算出来的）。
    expect(skipped.effectiveBudgetTokens).toBe(upper)
    expect(precise.effectiveBudgetTokens).toBe(exact)
  })

  it('跳过路径不做任何 JSON.stringify；读 token 数时才现算，且只算一次', () => {
    const items = buildConversation(6, 2)
    const expected = estimateItemsTokens(items)

    const spy = vi.spyOn(JSON, 'stringify')
    try {
      const result = compactContext(items, { maxTokens: 1_000_000 })
      const afterCompact = spy.mock.calls.length
      const first = result.estimatedTokensBefore
      const afterFirstRead = spy.mock.calls.length
      const second = result.estimatedTokensAfter
      const third = result.estimatedTokensBefore
      const afterMoreReads = spy.mock.calls.length

      // 本轮压缩本身一次序列化都没做 —— 这正是本次优化要拿到的东西。
      expect(afterCompact, 'compactContext 在粗筛跳过路径上仍然序列化了').toBe(0)
      // 真要读 token 数时照算不误，取值与精确口径一致。
      expect(afterFirstRead).toBeGreaterThan(0)
      expect(first).toBe(expected)
      expect(second).toBe(expected)
      expect(third).toBe(expected)
      // 缓存生效：重复读不重复序列化。
      expect(afterMoreReads).toBe(afterFirstRead)
    } finally {
      spy.mockRestore()
    }
  })

  it('超预算轮次仍照旧走精确路径，压缩行为与结果不受粗筛影响', () => {
    const items = buildConversation(6)
    const result = compactContext(items, { maxTokens: Math.floor(estimateItemsTokens(items) / 2) })

    expect(result.compacted).toBe(true)
    expect(result.estimatedTokensBefore).toBe(estimateItemsTokens(items))
    expect(result.estimatedTokensAfter).toBe(estimateItemsTokens(result.items))
    expect(result.estimatedTokensAfter).toBeLessThanOrEqual(result.effectiveBudgetTokens)
    assertNoOrphanToolMessages(result.items)
  })
})
