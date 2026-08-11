// E2 判据之「不减」：本轮被注销的工具，调用它时给结构化回执。
// ---------------------------------------------------------------------------
// E1 让被注销的工具留在清单里（保住 provider 前缀缓存与模型既有决策），代价是模型会照着清单
// 去调一个已经掉线的工具。这里钉住三件事：
//   · 回执是结构化的、写明「不是你的错、别原样重试」，而不是 registry 那句给运维看的
//     `unknown tool: X`，更不是静默消失；
//   · 拦截发生在闸门里——未加载的工具不会先被 autoload 一份注销前的 schema 白烧一轮，
//     request_tool_schema 点名它也不会白改一次 tool-set；
//   · 判据是活的：本轮内重连上来，它立刻恢复可用。

import { describe, expect, it } from 'vitest'
import { runAtom } from '../state/sessionAtoms'
import {
  SESSION_ID,
  dynamicTool,
  exposedToolNames,
  manifestTextOf,
  runWithResponses,
  seedCore,
  textResponse,
  toolCallsResponse,
  toolResultPayload,
} from './toolAvailability.testFixtures'

function expectDisconnected(payload: Record<string, unknown>, toolName: string): void {
  expect(payload.code).toBe('tool_provider_disconnected')
  expect(payload.retryable).toBe(false)
  expect(String(payload.error)).toContain(toolName)
  expect(String(payload.error)).toContain('MCP 服务在本轮已断开')
  // registry 的 `unknown tool: X` 会让模型以为自己名字写错了，于是原样重试。
  expect(String(payload.error)).not.toContain('unknown tool')
  expect(String(payload.hint)).toContain('不是你的调用出错')
  expect(String(payload.hint)).toContain('原样重试')
}

describe('run 期间不减（E2）', () => {
  it('调用一个本轮已被注销的工具，返回结构化回执而不是 unknown tool', async () => {
    const core = seedCore()

    const bodies = await runWithResponses(core, (turn) => {
      if (turn === 1) {
        return toolCallsResponse([{
          id: 'load-alpha',
          name: 'request_tool_schema',
          args: { toolName: 'alpha_tool', reason: '读取参数' },
        }])
      }
      if (turn === 2) {
        // 第 2 轮请求已经带着 alpha_tool 的 schema 发出；此刻它背后的 MCP 掉线。
        core.tools.unregister('alpha_tool')
        return toolCallsResponse([{ id: 'call-alpha', name: 'alpha_tool', args: { value: 'x' } }])
      }
      return textResponse('结束')
    })

    expectDisconnected(toolResultPayload(core, 'call-alpha'), 'alpha_tool')
    // E1 的承诺仍在：它没有从清单里消失，只是调用时被明确挡下。
    expect(manifestTextOf(bodies[2])).toContain('alpha_tool')
    expect(core.getSessionStore(SESSION_ID).store.getter(runAtom)?.status).toBe('done')
  })

  it('直接调用一个未加载且已掉线的工具，不会先 autoload 一份注销前的 schema', async () => {
    const core = seedCore()

    const bodies = await runWithResponses(core, (turn) => {
      if (turn === 1) {
        core.tools.unregister('alpha_tool')
        // alpha_tool 从没加载过，闸门本来会把这次调用当成一次 lazy 加载请求。
        return toolCallsResponse([{ id: 'blind-dead', name: 'alpha_tool', args: { value: 'x' } }])
      }
      return textResponse('结束')
    })

    expectDisconnected(toolResultPayload(core, 'blind-dead'), 'alpha_tool')
    expect(exposedToolNames(bodies[1])).toEqual(['request_tool_schema'])
  })

  it('request_tool_schema 点名一个已掉线的工具，当场给结构化回执，不白改一次 tool-set', async () => {
    const core = seedCore()

    const bodies = await runWithResponses(core, (turn) => {
      if (turn === 1) {
        core.tools.unregister('alpha_tool')
        return toolCallsResponse([{
          id: 'load-dead',
          name: 'request_tool_schema',
          args: { toolName: 'alpha_tool', reason: '读取参数' },
        }])
      }
      return textResponse('结束')
    })

    expectDisconnected(toolResultPayload(core, 'load-dead'), 'alpha_tool')
    // 没把注销前的 schema 加载进来：tools 不变，provider 前缀缓存也就不会被白白打断。
    expect(exposedToolNames(bodies[1])).toEqual(['request_tool_schema'])
  })

  it('掉线的工具在本轮内重连后立刻恢复可用（结构化回执只对真掉线生效）', async () => {
    const core = seedCore()

    await runWithResponses(core, (turn) => {
      if (turn === 1) {
        core.tools.unregister('alpha_tool')
        core.tools.register(dynamicTool('alpha_tool', 'alpha 重连后的指南'))
        return toolCallsResponse([{
          id: 'load-alpha',
          name: 'request_tool_schema',
          args: { toolName: 'alpha_tool', reason: '读取参数' },
        }])
      }
      if (turn === 2) {
        return toolCallsResponse([{ id: 'call-alpha', name: 'alpha_tool', args: { value: 'x' } }])
      }
      return textResponse('结束')
    })

    expect(toolResultPayload(core, 'load-alpha')).toMatchObject({
      loaded: true,
      guide: 'alpha 重连后的指南',
    })
    expect(toolResultPayload(core, 'call-alpha')).toEqual({ tool: 'alpha_tool' })
  })
})
