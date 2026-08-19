// 映射表本身的用例。**故意只喂「线上形状」而不是各域的错误类实例**：
// `McpCommandError` 这类没有出现在 `@einfach-agent/host-node` 的包级公开面上，而那正是本模块的
// 纪律——外壳只读字段，不认类型身份。真实类的端到端覆盖在 `invokeRouteFailure.test.ts`：那边经
// 真实 `createNodeHostInvoke()` + 真实 HTTP，证明真类抛出的 kind 确实会走到这条映射上。

import { NodeHostCommandError } from '@einfach-agent/host-node'
import { describe, expect, it } from 'vitest'
import {
  COMMAND_FAILURE_STATUS,
  mapInvokeRouteError,
  UNCLASSIFIED_COMMAND_FAILURE,
} from './invokeRouteError'

/** `McpCommandError.toJSON()` 的产物形状（host-node `mcp/errors.ts` 的 `McpCommandErrorJson`）。 */
function mcpFailureWire(kind: string, message: string): unknown {
  return { kind, message, serverId: 'srv-1' }
}

describe('mapInvokeRouteError：分发失败', () => {
  it('unknown-command 映射到 404', () => {
    const error = new NodeHostCommandError('bogus_command', 'unknown-command')
    const mapped = mapInvokeRouteError(error)
    expect(mapped.statusCode).toBe(404)
    expect(mapped.error).toBe('unknown_command')
    // 直接复用 host-node 的文案，不重新组一遍——避免两处中文各写一份、后续漂移。
    expect(mapped.message).toBe(error.message)
  })

  it('unimplemented 映射到 501', () => {
    const error = new NodeHostCommandError('mcp_list_tools', 'unimplemented')
    const mapped = mapInvokeRouteError(error)
    expect(mapped.statusCode).toBe(501)
    expect(mapped.error).toBe('command_not_implemented')
    expect(mapped.message).toBe(error.message)
  })

  // 判别面是字段不是类型身份：sidecar 那条路上原型没了，只剩一袋 JSON。
  it('分发失败经序列化之后仍然认得出', () => {
    const original = new NodeHostCommandError('x', 'unknown-command')
    const wire = { reason: original.reason, message: original.message }
    expect(mapInvokeRouteError(wire).statusCode).toBe(404)
  })

  // 分发表用 `Object.hasOwn` 查而不是 `in`：`in` 会走原型链，于是 `reason: 'constructor'`
  // （或 `toString` / `valueOf`）当场命中 `Object.prototype`，一个来自外部载荷的抛出物就能
  // 冒充成分发失败，把 502 变成 404/501。
  it('reason 撞上 Object.prototype 的键名时不冒充分发失败', () => {
    for (const reason of ['constructor', 'toString', 'valueOf', '__proto__']) {
      const mapped = mapInvokeRouteError(Object.assign(new Error('伪装'), { reason }))
      expect(mapped.statusCode).toBe(COMMAND_FAILURE_STATUS)
      expect(mapped.error).toBe(UNCLASSIFIED_COMMAND_FAILURE)
    }
  })
})

describe('mapInvokeRouteError：命令自身失败', () => {
  it('MCP 失败带出 kind，状态码是命令失败档', () => {
    const mapped = mapInvokeRouteError(
      mcpFailureWire('command_spawn_failed', 'no such file or directory'),
    )
    expect(mapped.statusCode).toBe(COMMAND_FAILURE_STATUS)
    expect(mapped.error).toBe('command_spawn_failed')
    expect(mapped.message).toBe('no such file or directory')
  })

  // kind 是开放取值：host-node/Rust 新增一类失败时，本层必须原样转发而不是吞成 undefined
  // ——那正好把「新增一类永久失败」变成「安静地无限重连」。
  it('没见过的 kind 原样转发，不落兜底码', () => {
    expect(mapInvokeRouteError(mcpFailureWire('a_brand_new_kind', 'x')).error)
      .toBe('a_brand_new_kind')
  })

  it('model 域的 reason 也带得出（同一条路由上不给某一个域开特例）', () => {
    const mapped = mapInvokeRouteError(
      Object.assign(new Error('宿主配置里那一段坏了'), { reason: 'credential-config-invalid' }),
    )
    expect(mapped.statusCode).toBe(COMMAND_FAILURE_STATUS)
    expect(mapped.error).toBe('credential-config-invalid')
  })

  it('model 域没登记的 reason 取值不冒充标识', () => {
    expect(mapInvokeRouteError(Object.assign(new Error('x'), { reason: 'made-up' })).error)
      .toBe(UNCLASSIFIED_COMMAND_FAILURE)
  })

  it('没有结构化标识的域落兜底码，但那句话原样带出去', () => {
    const mapped = mapInvokeRouteError(new Error('SQL 里有未闭合的块注释'))
    expect(mapped.statusCode).toBe(COMMAND_FAILURE_STATUS)
    expect(mapped.error).toBe(UNCLASSIFIED_COMMAND_FAILURE)
    expect(mapped.message).toBe('SQL 里有未闭合的块注释')
  })

  it('裸字符串抛出物（Tauri invoke 的 reject 形状）也取得到那句话', () => {
    expect(mapInvokeRouteError('权限不足').message).toBe('权限不足')
  })

  it('连一句话都没有时给兜底文案，不把未知值字符串化发出去', () => {
    for (const thrown of [undefined, null, 42, new Error(''), new Error('   ')]) {
      const mapped = mapInvokeRouteError(thrown)
      expect(mapped.statusCode).toBe(COMMAND_FAILURE_STATUS)
      expect(mapped.error).toBe(UNCLASSIFIED_COMMAND_FAILURE)
      expect(mapped.message.length).toBeGreaterThan(0)
      expect(mapped.message).not.toContain('[object')
    }
  })

  it('空 kind 不算标识（Rust 那边 kind 恒非空，空串只可能来自坏数据）', () => {
    expect(mapInvokeRouteError(Object.assign(new Error('x'), { kind: '' })).error)
      .toBe(UNCLASSIFIED_COMMAND_FAILURE)
  })
})
