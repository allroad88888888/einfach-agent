// E2 判据之「只增」：run 中途新注册的工具，本轮就能用。
// ---------------------------------------------------------------------------
// E1 把清单钉死在 run 开始那一刻，于是 registry 与清单会在 run 中途分叉。这里钉住分叉的
// 一侧：新注册的工具【可点名加载、可真正执行】，但【不进】注入的 manifest 文本——
// 一旦进了，模型就会同时看到两套互相矛盾的工具清单，provider 前缀缓存也会整段失效。

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

describe('run 期间只增（E2）', () => {
  it('run 中途注册的工具可以被点名加载并执行，但不进注入的 manifest', async () => {
    const core = seedCore()

    const bodies = await runWithResponses(core, (turn) => {
      if (turn === 1) {
        // 本 run 开始之后，一台 MCP 服务连上来并注册了新工具。
        core.tools.register(dynamicTool('gamma_tool', 'gamma 的完整指南：run 中途才出现'))
        return toolCallsResponse([{
          id: 'load-gamma',
          name: 'request_tool_schema',
          args: { toolName: 'gamma_tool', reason: '读取参数' },
        }])
      }
      if (turn === 2) {
        return toolCallsResponse([{ id: 'call-gamma', name: 'gamma_tool', args: { value: 'x' } }])
      }
      return textResponse('结束')
    })

    expect(bodies).toHaveLength(3)
    // ① 点名加载成功——中途注册的工具不再是「不存在」。
    expect(toolResultPayload(core, 'load-gamma')).toMatchObject({
      loaded: true,
      toolName: 'gamma_tool',
      guide: 'gamma 的完整指南：run 中途才出现',
    })
    // ② 它真的进了下一轮的 tools，并且真的执行了。
    expect(exposedToolNames(bodies[1])).toEqual(['gamma_tool', 'request_tool_schema'])
    expect(toolResultPayload(core, 'call-gamma')).toEqual({ tool: 'gamma_tool' })

    // ③ E1 的承诺不受影响：注入的 manifest 文本三轮逐字相同，且始终不含 gamma_tool。
    const manifests = bodies.map(manifestTextOf)
    expect(new Set(manifests).size).toBe(1)
    expect(manifests[0]).toContain('alpha_tool')
    expect(manifests[0]).toContain('beta_tool')
    expect(manifests[0]).not.toContain('gamma_tool')

    expect(core.getSessionStore(SESSION_ID).store.getter(runAtom)?.status).toBe('done')
  })

  it('中途注册的工具被直接调用时走 autoload，而不是被判成 not allowed', async () => {
    const core = seedCore()

    const bodies = await runWithResponses(core, (turn) => {
      if (turn === 1) {
        core.tools.register(dynamicTool('gamma_tool', 'gamma 的完整指南'))
        return toolCallsResponse([{ id: 'blind-gamma', name: 'gamma_tool', args: { value: 'x' } }])
      }
      return textResponse('结束')
    })

    // lazy-tool 协议：本次不执行，但 schema 已加载，下一轮就能正常调用。
    expect(toolResultPayload(core, 'blind-gamma')).toMatchObject({
      code: 'tool_schema_autoloaded',
      toolName: 'gamma_tool',
      executed: false,
    })
    expect(exposedToolNames(bodies[1])).toEqual(['gamma_tool', 'request_tool_schema'])
  })
})
