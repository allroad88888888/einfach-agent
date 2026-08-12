// 一次 `mcp__*` 调用的起进程分级矩阵（D3a）。
//
// 透明连接把「调用一个工具」和「在本机起一个进程」合成了一步：未连接服务的占位被直接调用时，
// 执行前会先连接，stdio 的那一次连接就是一次起进程。本文件钉的就是这个矩阵——判定只在
// classifyToolRisk 一处，事实只从注入的探针进来。
//
// 【为什么与 dangerousTools.test.ts 分开】那边是「危险工具集 + shell 命令行」的既有矩阵，
// 这边是 MCP 透明连接这一条新准入；两组用例的 fixture（探针）也完全不同。

import { describe, expect, it, vi } from 'vitest'
import {
  classifyToolRisk,
  isDelegatableDangerousTool,
  type McpToolLaunchTargetProbe,
} from './dangerousTools'

const UNSEEN_COMMAND = 'npx -y @imported/from-untrusted-json'
const SEEN_COMMAND = 'node /Users/me/tools/server.js --stdio'

/** 宿主合成出来的事实：这次调用会不会起进程、跑哪条命令、那条命令用户看过没有。 */
const probe: McpToolLaunchTargetProbe = (toolName) => {
  // 未连接的 stdio 服务，启动命令从没被人看过（导入一份 JSON 就躺在配置里）。
  if (toolName === 'mcp__unseen__run') {
    return { spawnsLocalProcess: true, command: UNSEEN_COMMAND, launchConsented: false }
  }
  // 未连接的 stdio 服务，用户亲眼确认过这条命令行。
  if (toolName === 'mcp__seen__run') {
    return { spawnsLocalProcess: true, command: SEEN_COMMAND, launchConsented: true }
  }
  // 未连接的 stdio 服务，但宿主报不出命令行，也报不出确认状态。
  if (toolName === 'mcp__quiet__run') return { spawnsLocalProcess: true }
  // 未连接的 HTTP 服务：连接只发一次网络请求，本机不起任何东西。
  if (toolName === 'mcp__remote__search') return { spawnsLocalProcess: false }
  // 其余（已连接的服务、不是占位的名字）：这次调用不会拉起任何进程。
  return undefined
}

describe('classifyToolRisk · mcp__* 调用的起进程分级', () => {
  /**
   * D3a 的核心判据。用户以为自己只是存了一份配置，而模型直接调一个占位工具就会把它跑起来——
   * Auto 模式也必须先把那条命令摆到用户面前。
   */
  it('未连接 + stdio + 未确认 → dangerous 且 requiresConfirmation（Auto 也暂停）', () => {
    const risk = classifyToolRisk('mcp__unseen__run', { query: 'x' }, { mcpToolLaunchTarget: probe })

    expect(risk.level).toBe('dangerous')
    expect(risk.requiresConfirmation).toBe(true)
    // 卡片上必须同时说清两件事：这次调用会先连接，以及连接会跑哪条没人看过的命令。
    expect(risk.reason).toContain('尚未连接')
    expect(risk.reason).toContain('还没有确认过')
    expect(risk.reason).toContain(UNSEEN_COMMAND)
  })

  it('宿主报不出确认状态（字段缺省）一律按未确认处理', () => {
    expect(classifyToolRisk('mcp__quiet__run', {}, { mcpToolLaunchTarget: probe }))
      .toMatchObject({ level: 'dangerous', requiresConfirmation: true })
  })

  it('未连接 + stdio + 已确认 → 普通 dangerous，Auto 放行，但仍摆出那条命令', () => {
    const risk = classifyToolRisk('mcp__seen__run', {}, { mcpToolLaunchTarget: probe })

    expect(risk.level).toBe('dangerous')
    expect(risk.requiresConfirmation).toBeUndefined()
    expect(risk.reason).toContain(SEEN_COMMAND)
  })

  it('超长命令行截断后仍看得出是什么命令，不整段灌进确认卡片', () => {
    const longCommand = `node ${'a'.repeat(400)}.js`
    const risk = classifyToolRisk('mcp__x__y', {}, {
      mcpToolLaunchTarget: () => ({ spawnsLocalProcess: true, command: longCommand }),
    })

    expect(risk.reason).toContain('node aaa')
    expect(risk.reason).toContain('…')
    expect(risk.reason?.length).toBeLessThan(longCommand.length)
  })

  // 零回归的一组：今天 mcp__* 就是 dangerous、Auto 直接执行，这几条不能因为 D3a 变成暂停。
  it.each([
    ['未连接的 HTTP 服务', 'mcp__remote__search', probe],
    ['已连接的服务（探针答 undefined）', 'mcp__github__create_issue', probe],
    ['宿主没接这根线', 'mcp__unseen__run', undefined],
  ])('%s → 维持既有 dangerous，不打断 Auto', (_label, toolName, injected) => {
    expect(classifyToolRisk(toolName, { title: 'test' }, { mcpToolLaunchTarget: injected }))
      .toEqual({ level: 'dangerous' })
  })

  it('完全不传 context 时也只是 dangerous（不从严）', () => {
    expect(classifyToolRisk('mcp__github__create_issue', { title: 'test' }))
      .toEqual({ level: 'dangerous' })
  })

  /**
   * 探针抛错【不】升级成必须确认——这是与 connect_mcp_server 那一路刻意相反的默认方向。
   * 从严的代价是：宿主的探针一坏，已连接服务的每一次普通调用都会在 Auto 模式下停下来问，
   * 那是回归。这条路径的安全性由装配硬约束保证（占位注册与探针同处接线、同进同退），
   * 不靠这里的默认方向兜底。
   */
  it('探针抛错不穿透风险判定，也不升级为必须确认', () => {
    expect(classifyToolRisk('mcp__unseen__run', {}, {
      mcpToolLaunchTarget: () => { throw new Error('宿主挂了') },
    })).toEqual({ level: 'dangerous' })
  })

  it('判据来自工具名而不是参数：同一个名字换任何 args 结论都一样', () => {
    const first = classifyToolRisk('mcp__unseen__run', { a: 1 }, { mcpToolLaunchTarget: probe })
    const second = classifyToolRisk('mcp__unseen__run', 'not-an-object', {
      mcpToolLaunchTarget: probe,
    })

    expect(second).toEqual(first)
  })

  it('非 MCP 工具根本不问这个探针', () => {
    const spy = vi.fn(probe)

    expect(classifyToolRisk('write_file', { path: 'a' }, { mcpToolLaunchTarget: spy }).level)
      .toBe('dangerous')
    expect(classifyToolRisk('read_file', { path: 'a' }, { mcpToolLaunchTarget: spy }).level)
      .toBe('safe')
    expect(spy).not.toHaveBeenCalled()
  })

  // 透明连接不得从子 Agent 边界内发生：mcp__* 一如既往不可显式授权。
  it('mcp__* 仍然不可授权给子 agent', () => {
    expect(isDelegatableDangerousTool('mcp__unseen__run')).toBe(false)
  })
})
