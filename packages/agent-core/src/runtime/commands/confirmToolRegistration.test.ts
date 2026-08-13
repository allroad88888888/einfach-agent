// E3 判据：待确认工具在「用户点允许」那一刻的可执行性，一律由本 run 的工具集 epoch 说了算。
// ---------------------------------------------------------------------------
// 等待确认的那几分钟正好是 MCP 最可能重连或掉线的窗口。这里钉住四件事：
//   · 版本一致 → 照常执行（epoch 接管判据后，正常路径不许被误伤）；
//   · 同名换了一版 → 仍由 registry 的 expectedRegistrationVersion fail-closed 挡下，
//     回 `tool registration version mismatch`，模型重读 schema 可自愈（原行为，不许回退）；
//   · 服务已断开（epoch.status === 'retired'）→ 改回 E2 的 tool_provider_disconnected，
//     而不是给运维看的 `unknown tool: X`；
//   · 拿不到 epoch（进程重启 / 被新 run 顶掉）→ 回退活 registry 判据，仍然 fail-closed，
//     绝不因为「没有判据」就放行执行。

import { describe, expect, it, vi } from 'vitest'
import { itemsAtom, runAtom } from '../../state/sessionAtoms'
import { alwaysAllowedToolsAtom } from '../../state/transientAtoms'
import { createCore } from '../core/createCore'
import { textResponse, toolCallsResponse } from '../toolAvailability.testFixtures'
import type { CorePlugin } from '../core/pluginHost'
import type { Tool } from '../../tools/types'

// 名字取自内建危险工具集，于是它在 confirm 模式下必然暂停等确认；同时不带 mcp__ 前缀，
// 好让「一律允许」这一路也进入断言（判据全程只看 epoch.status，不看名字长什么样）。
const TOOL = 'write_file'
const CALL_ID = 'pending-call'

type TestCore = ReturnType<typeof createCore>

function dangerousTool(execute: () => { ok: true; data: unknown }): Tool {
  return {
    name: TOOL,
    runtime: 'internal',
    skill: { description: '写文件（测试替身）', content: '把内容写进工作区文件' },
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    execute,
  }
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function runIdOf(core: TestCore, id: string): string {
  const runId = core.getSessionStore(id).store.getter(runAtom)?.runId
  if (!runId) throw new Error('缺少 runId')
  return runId
}

function resultPayload(core: TestCore, id: string): Record<string, unknown> {
  const item = core.getSessionStore(id).store.getter(itemsAtom).find(
    ({ item: entry }) => entry.role === 'tool' && entry.tool_call_id === CALL_ID,
  )?.item
  if (!item || item.role !== 'tool') throw new Error('缺少确认恢复后的工具结果')
  return JSON.parse(item.content) as Record<string, unknown>
}

/** 跑到「危险工具等待确认」为止：run 已退出循环，epoch 仍按 (sessionId, runId) 留着。 */
async function pauseAtConfirmation(
  execute: () => { ok: true; data: unknown },
  plugins?: readonly CorePlugin[],
): Promise<{ core: TestCore; id: string }> {
  let turn = 0
  const fetchImpl: typeof fetch = async () => {
    turn += 1
    if (turn === 1) {
      return toolCallsResponse([{ id: 'load', name: 'request_tool_schema', args: { toolName: TOOL, reason: '读取参数' } }])
    }
    if (turn === 2) return toolCallsResponse([{ id: CALL_ID, name: TOOL, args: { path: 'a.txt' } }])
    return textResponse('已处理')
  }
  const core = createCore({ config: { modelCredentials: { deepseek: 'k' }, fetchImpl }, ...(plugins ? { plugins } : {}) })
  core.tools.register(dangerousTool(execute))
  const id = core.newSession({ settings: { vendor: 'deepseek', model: 'x' } })
  core.sendMessage('写个文件')
  await waitUntil(
    () => core.getSessionStore(id).store.getter(runAtom)?.status === 'waiting_confirmation'
      && !core.abort.isRunning(id),
    'waiting_confirmation',
  )
  expect(core.getSessionStore(id).store.getter(runAtom)?.pendingToolConfirmation).toMatchObject({
    callId: CALL_ID,
    toolName: TOOL,
    registrationVersion: core.tools.registrationVersion(TOOL),
  })
  return { core, id }
}

async function confirmAndSettle(core: TestCore, id: string): Promise<void> {
  core.confirmTool(true, true)
  await waitUntil(
    () => core.getSessionStore(id).store.getter(runAtom)?.status === 'done',
    'resumed run completion',
  )
}

describe('确认恢复的注册校验并入 run 工具集 epoch（E3）', () => {
  it('版本一致：epoch 接管判据后照常执行，并记住「一律允许」', async () => {
    const execute = vi.fn(() => ({ ok: true as const, data: { written: true } }))
    const { core, id } = await pauseAtConfirmation(execute)

    await confirmAndSettle(core, id)

    expect(execute).toHaveBeenCalledTimes(1)
    expect(resultPayload(core, id)).toEqual({ written: true })
    expect(core.getSessionStore(id).store.getter(alwaysAllowedToolsAtom)).toContain(TOOL)
  })

  it('实例被换掉：仍 fail-closed 回 registration version mismatch，且不记住「一律允许」', async () => {
    const oldExecute = vi.fn(() => ({ ok: true as const, data: { implementation: 'old' } }))
    const newExecute = vi.fn(() => ({ ok: true as const, data: { implementation: 'new' } }))
    const { core, id } = await pauseAtConfirmation(oldExecute)
    const oldVersion = core.tools.registrationVersion(TOOL)

    // 用户盯着卡片的这段时间里，服务重连并换了一个同名实例。
    core.tools.register(dangerousTool(newExecute))
    const newVersion = core.tools.registrationVersion(TOOL)
    expect(newVersion).toBeGreaterThan(oldVersion!)
    // 成员「跟随活注册」：epoch 看到的就是新那一版，所以它能自己判出版本变了。
    expect(core.toolEpochs.get(id, runIdOf(core, id))?.status(TOOL)).toBe('live')

    await confirmAndSettle(core, id)

    expect(oldExecute).not.toHaveBeenCalled()
    expect(newExecute).not.toHaveBeenCalled()
    const payload = resultPayload(core, id)
    expect(String(payload.error)).toContain('tool registration version mismatch')
    expect(String(payload.error)).toContain(`expected ${oldVersion}`)
    expect(String(payload.error)).toContain(`current ${newVersion}`)
    // 这一支是「可自愈」的那一半，不能被误判成本轮无救。
    expect(payload.code).not.toBe('tool_provider_disconnected')
    expect(core.getSessionStore(id).store.getter(alwaysAllowedToolsAtom)).not.toContain(TOOL)
  })

  it('服务已断开：在决策处就回 tool_provider_disconnected，不再把必败的调用送进执行路径', async () => {
    const execute = vi.fn(() => ({ ok: true as const, data: { written: true } }))
    const { core, id } = await pauseAtConfirmation(execute)

    // 用户盯着卡片的这段时间里，提供该工具的服务掉线了。
    core.tools.unregister(TOOL)
    expect(core.toolEpochs.get(id, runIdOf(core, id))?.status(TOOL)).toBe('retired')
    const runTool = vi.spyOn(core.tools, 'run')

    await confirmAndSettle(core, id)

    // 本轮无救是在命令层就判定的：不再交给 registry.run 去撞一句 `unknown tool: X`
    // 再由执行侧翻译（E2 的兜底仍在，但不该是这条路径唯一的保险）。
    expect(runTool).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    const payload = resultPayload(core, id)
    expect(payload.code).toBe('tool_provider_disconnected')
    expect(payload.retryable).toBe(false)
    expect(String(payload.error)).toContain(TOOL)
    expect(String(payload.error)).toContain('MCP 服务在本轮已断开')
    expect(String(payload.error)).not.toContain('unknown tool')
    expect(String(payload.error)).not.toContain('tool registration version mismatch')
    expect(String(payload.hint)).toContain('不是你的调用出错')
    expect(String(payload.hint)).toContain('原样重试')
    expect(core.getSessionStore(id).store.getter(alwaysAllowedToolsAtom)).not.toContain(TOOL)
  })

  it('服务已断开且装了 afterToolCall 插件：不再从校验路径漏出 unknown tool', async () => {
    // 只装 afterToolCall（不装 beforeToolCall）时，pending 上没有 beforeToolHookCompleted，
    // 恢复会重跑一次 prepareToolCall——那里读的是活 registry，工具没了就直接回
    // `unknown tool: X`，执行侧的 E2 翻译根本轮不到。掉线判定必须发生在这之前。
    const execute = vi.fn(() => ({ ok: true as const, data: { written: true } }))
    const afterToolCall = vi.fn()
    const plugin: CorePlugin = {
      activate: (api) => api.hook('afterToolCall', (_ctx, event) => {
        afterToolCall(event.toolName)
        return undefined
      }),
    }
    const { core, id } = await pauseAtConfirmation(execute, [plugin])

    try {
      core.tools.unregister(TOOL)

      await confirmAndSettle(core, id)

      const payload = resultPayload(core, id)
      expect(payload.code).toBe('tool_provider_disconnected')
      expect(String(payload.error)).not.toContain('unknown tool')
      expect(execute).not.toHaveBeenCalled()
      expect(afterToolCall).not.toHaveBeenCalled()
    } finally {
      core.plugins.dispose()
    }
  })

  it('拿不到 epoch：回退活 registry 判据，重注册仍被挡下', async () => {
    const oldExecute = vi.fn(() => ({ ok: true as const, data: { implementation: 'old' } }))
    const newExecute = vi.fn(() => ({ ok: true as const, data: { implementation: 'new' } }))
    const { core, id } = await pauseAtConfirmation(oldExecute)
    const oldVersion = core.tools.registrationVersion(TOOL)
    const runId = runIdOf(core, id)

    // 进程重启 / 该会话的 epoch 被新 run 顶掉：确认恢复时按 (sessionId, runId) 已经取不到。
    core.toolEpochs.release(id)
    expect(core.toolEpochs.get(id, runId)).toBeUndefined()
    core.tools.register(dangerousTool(newExecute))
    const newVersion = core.tools.registrationVersion(TOOL)

    await confirmAndSettle(core, id)

    expect(oldExecute).not.toHaveBeenCalled()
    expect(newExecute).not.toHaveBeenCalled()
    const payload = resultPayload(core, id)
    expect(String(payload.error)).toContain('tool registration version mismatch')
    expect(String(payload.error)).toContain(`expected ${oldVersion}`)
    expect(String(payload.error)).toContain(`current ${newVersion}`)
    expect(core.getSessionStore(id).store.getter(alwaysAllowedToolsAtom)).not.toContain(TOOL)
  })

  it('拿不到 epoch 且工具已消失：不放行执行，也不冒充「一律允许」', async () => {
    const execute = vi.fn(() => ({ ok: true as const, data: { written: true } }))
    const { core, id } = await pauseAtConfirmation(execute)
    const runId = runIdOf(core, id)

    core.toolEpochs.release(id)
    core.tools.unregister(TOOL)
    expect(core.toolEpochs.get(id, runId)).toBeUndefined()

    await confirmAndSettle(core, id)

    // 没有 epoch 就没有「本 run 开始时的清单」，无从区分掉线与从来就没有；此时唯一的正确
    // 动作是维持原兜底：仍旧不执行、不记住授权，把失败如实回给模型。
    expect(execute).not.toHaveBeenCalled()
    expect(String(resultPayload(core, id).error)).toBeTruthy()
    expect(core.getSessionStore(id).store.getter(alwaysAllowedToolsAtom)).not.toContain(TOOL)
  })
})
