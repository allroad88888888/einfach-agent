import { describe, expect, it } from 'vitest'
import type { ModelItem } from '@einfach-agent/ai'
import { itemsAtom } from '../state/sessionAtoms'
import { sessionsAtom } from '../state/rootStore'
import type { Tool } from '../tools/types'
import { createCoreInstance } from './core/coreInstance'
import type { CorePlugin } from './core/pluginHost'
import { runSession } from './runToolLoop'
import { projectTimedToolResultOrphans } from './timedToolResultProjection'

function sessionStartTool(): Tool {
  return {
    name: 'timed_manifest_fixture',
    runtime: 'internal',
    skill: { description: '测试 sessionStart 清单', content: '测试 sessionStart 清单' },
    inputSchema: { type: 'object', additionalProperties: false },
    callTiming: 'sessionStart',
    execute: () => ({ ok: true, data: 'L1 清单' }),
  }
}

function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function seedSession(core: ReturnType<typeof createCoreInstance>, id: string): void {
  core.rootStore.setter(sessionsAtom, {
    [id]: {
      id,
      title: 'timed projection',
      settings: { vendor: 'deepseek', model: 'x' },
      createdAt: 0,
      updatedAt: 0,
    },
  })
}

function timedToolIndex(messages: readonly ModelItem[]): number {
  return messages.findIndex((message) => (
    message.role === 'tool'
      && message.tool_call_id === 'timed:sessionStart:timed_manifest_fixture'
  ))
}

describe('sessionStart timed tool 的请求组装', () => {
  it('投影前是孤儿 tool item，发送时紧贴补配对 assistant，且 timeline 不持久化合成项', async () => {
    const id = 'timed-request-orphan'
    let beforeProjection: ModelItem[] = []
    const plugin: CorePlugin = {
      activate(api) {
        api.hook('prepareRequest', (_ctx, draft) => {
          beforeProjection = structuredClone(draft.messages)
        })
      },
    }
    const core = createCoreInstance({
      plugins: [plugin],
      registerTools: (registry) => registry.register(sessionStartTool()),
    })
    seedSession(core, id)
    let requestMessages: ModelItem[] = []

    await runSession(id, '开始', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl: async (_input, init) => {
        requestMessages = (JSON.parse(String(init?.body)) as { messages: ModelItem[] }).messages
        return jsonResponse('完成')
      },
      core,
    })

    const index = timedToolIndex(requestMessages)
    expect(index).toBeGreaterThan(0)
    const timelineTool = {
      role: 'tool',
      tool_call_id: 'timed:sessionStart:timed_manifest_fixture',
      content: '"L1 清单"',
    } as const
    const beforeIndex = timedToolIndex(beforeProjection)
    expect(beforeProjection[beforeIndex]).toEqual(timelineTool)
    expect(beforeProjection[beforeIndex - 1]).not.toMatchObject({
      role: 'assistant',
      tool_calls: expect.any(Array),
    })
    expect(requestMessages.slice(index - 1, index + 1)).toEqual([
      {
        role: 'assistant',
        content: '',
        // deepseek adapter 对工具调用轮统一补空 reasoning_content（thinking 家族校验要求）。
        reasoning_content: '',
        tool_calls: [{
          id: 'timed:sessionStart:timed_manifest_fixture',
          type: 'function',
          function: { name: 'timed_tool_result', arguments: '{}' },
        }],
      },
      timelineTool,
    ])
    const timeline = core.getSessionStore(id).store.getter(itemsAtom).map(({ item }) => item)
    expect(timedToolIndex(timeline)).toBeGreaterThan(-1)
    expect(timeline.some((item) => (
      item.role === 'assistant' && item.tool_calls?.some((call) => (
        call.id === 'timed:sessionStart:timed_manifest_fixture'
      ))
    ))).toBe(false)
  })

  it('保留已有 assistant tool_call 的历史和非 timed 孤儿，且为每个 timed 孤儿分别补对', () => {
    const alreadyPaired: ModelItem[] = [
      {
        role: 'assistant',
        content: '读取中',
        tool_calls: [{
          id: 'timed:declared',
          type: 'function',
          function: { name: 'existing_tool', arguments: '{"path":"a"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'timed:declared', content: '已读取' },
    ]
    expect(projectTimedToolResultOrphans(alreadyPaired)).toBe(alreadyPaired)

    const source: ModelItem[] = [
      { role: 'user', content: '开始' },
      { role: 'tool', tool_call_id: 'unknown-call', content: '保留' },
      { role: 'tool', tool_call_id: 'timed:sessionStart:first', content: '第一份' },
      { role: 'tool', tool_call_id: 'timed:sessionStart:second', content: '第二份' },
    ]
    expect(projectTimedToolResultOrphans(source)).toEqual([
      source[0],
      source[1],
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'timed:sessionStart:first',
          type: 'function',
          function: { name: 'timed_tool_result', arguments: '{}' },
        }],
      },
      source[2],
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'timed:sessionStart:second',
          type: 'function',
          function: { name: 'timed_tool_result', arguments: '{}' },
        }],
      },
      source[3],
    ])
  })

  it('合成 timed 孤儿时保留前一 assistant 尚未消费的多个 call', () => {
    const source: ModelItem[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'model:first', type: 'function', function: { name: 'first', arguments: '{}' } },
          { id: 'timed:model:second', type: 'function', function: { name: 'second', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'model:first', content: '第一项' },
      { role: 'tool', tool_call_id: 'timed:sessionStart:manifest', content: '清单' },
      { role: 'tool', tool_call_id: 'timed:model:second', content: '第二项' },
    ]

    expect(projectTimedToolResultOrphans(source)).toEqual([
      source[0],
      source[1],
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'timed:sessionStart:manifest',
          type: 'function',
          function: { name: 'timed_tool_result', arguments: '{}' },
        }],
      },
      source[2],
      source[3],
    ])
  })
})
