// 一条契约，从两个方向钉住：**裁决只由 kind 决定，且每个抛出点的 kind 都有裁决。**
// ---------------------------------------------------------------------------
// 前者是铁律（永久结论只能来自对端不参与撰写的信号）在后端这一半：message 里嵌着对端写的文本，
// 所以判定的输入只能是 host-node 自己铸造的 kind。后者是「表不许过期」：漏登记一个 kind，
// 客户端就会退到可重试，一个永远起不来的服务被无限重连。

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { McpCommandError } from './errors'
import { mcpFailureVerdictForKind, readMcpFailureVerdict } from './failureKinds'

describe('裁决只看 kind', () => {
  it('同一个 kind 配上互相矛盾的 message，裁决逐字相同', () => {
    // 这些 message 分别「像」暂时失败、像另一类永久失败、以及空。都不许改变结果——否则一台
    // MCP server 只要在自己的错误文案里写一句 "must not be empty" 就能操纵重试策略。
    const messages = [
      'failed to start MCP server `local-files`: ENOENT',
      'transport lost, will retry',
      'MCP server id must not be empty',
      '',
    ]

    const verdicts = messages.map((message) =>
      readMcpFailureVerdict(new McpCommandError('command_spawn_failed', message)),
    )

    for (const verdict of verdicts) {
      expect(verdict).toEqual({ retryable: false, reason: 'command_unavailable' })
    }
  })

  it('对端撰写 message 的那一支永远是可重试', () => {
    // `rpc_error` 的 message 冒号之后整段是 MCP server 写的。
    expect(
      readMcpFailureVerdict(
        new McpCommandError('rpc_error', 'MCP request `tools/call` failed: exceeded 5 tools (-32000)'),
      ),
    ).toEqual({ retryable: true, reason: 'connection_disrupted' })
  })

  it('三类永久失败与它们的归因', () => {
    expect(mcpFailureVerdictForKind('invalid_input')).toEqual({
      retryable: false,
      reason: 'config_invalid',
    })
    expect(mcpFailureVerdictForKind('command_spawn_failed')).toEqual({
      retryable: false,
      reason: 'command_unavailable',
    })
    expect(mcpFailureVerdictForKind('protocol_error')).toEqual({
      retryable: false,
      reason: 'protocol_violation',
    })
  })

  it('子进程起来之后的宿主侧失败仍可重试——与「命令不存在」分得开', () => {
    expect(mcpFailureVerdictForKind('spawn_failed')?.retryable).toBe(true)
    expect(mcpFailureVerdictForKind('command_spawn_failed')?.retryable).toBe(false)
  })
})

describe('读取面：拿不到就说拿不到', () => {
  it('跨 HTTP 序列化之后仍然判得出（读的是字段，不是类型身份）', () => {
    const wire: unknown = JSON.parse(
      JSON.stringify(new McpCommandError('protocol_error', 'invalid tools/list result')),
    )

    expect(readMcpFailureVerdict(wire)).toEqual({ retryable: false, reason: 'protocol_violation' })
  })

  it('没登记的 kind、没有 kind、根本不是对象，一律 undefined', () => {
    expect(mcpFailureVerdictForKind('a_kind_added_later')).toBeUndefined()
    // 原型链上的键不算登记项：`in` 会把它算进来。
    expect(mcpFailureVerdictForKind('constructor')).toBeUndefined()
    expect(readMcpFailureVerdict(new Error('boom'))).toBeUndefined()
    expect(readMcpFailureVerdict('not an error')).toBeUndefined()
  })
})

describe('表不许过期', () => {
  it('mcp 域每个抛出点的 kind 都登记了裁决', () => {
    // 闭合 union 已经让漏登记成为编译错误；这条用例守的是**union 被改回 `string`** 的那一天
    // ——那时编译期的网没了，而症状仍然是「没有症状」。所以直接读源码文本对拍。
    const mcpDir = dirname(fileURLToPath(import.meta.url))
    const kinds = new Set<string>()
    for (const entry of readdirSync(mcpDir)) {
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue
      const source = readFileSync(join(mcpDir, entry), 'utf8')
      for (const match of source.matchAll(/new McpCommandError\(\s*'([a-z_]+)'/g)) {
        kinds.add(match[1] as string)
      }
    }

    // 匹配不到任何抛出点就是这条守卫本身失效了（写法变了），必须当场红而不是恒绿。
    expect(kinds.size).toBeGreaterThan(5)
    for (const kind of kinds) {
      expect(mcpFailureVerdictForKind(kind), `kind ${kind} 没有登记裁决`).toBeDefined()
    }
  })
})
