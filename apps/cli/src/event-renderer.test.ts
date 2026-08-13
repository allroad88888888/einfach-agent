import { afterEach, describe, expect, it } from 'vitest'
import { newSession, removeSession } from '@web-agent/core/runtime/commands'
import { defaultCore } from '@web-agent/core/runtime/core/coreInstance'
import { itemsAtom } from '@web-agent/core/state/sessionAtoms'
import { setAssistantStream } from '@web-agent/core/state/transientAtoms'
import type { ConversationItem } from '@web-agent/core/state/core.type'
import { subscribeCliRenderer } from './event-renderer'

const sessionIds: string[] = []

function assistant(id: string, content: string, pending = true): ConversationItem {
  return { id, createdAt: 1, pending, item: { role: 'assistant', content } }
}

// 本文件测的是 subscribeCliRenderer 对 itemsAtom 变化的反应，不是写入器本身——
// state/sessionWriters 是 D 类（仅测试在用），CLAUDE.md 明令「UI 不直接调用 writer」，
// 这两个本地 helper 直接对该会话 store 的 itemsAtom 做不可变更新，绕开那条内部深导入，
// 效果与 appendItem/updateItem 对 itemsAtom 的改动一致（不复现它们的 touchSession 副作用，
// 本文件的断言从不依赖 rootStore 的 updatedAt）。
function appendItem(sessionId: string, item: ConversationItem): void {
  defaultCore.getSessionStore(sessionId).store.setter(itemsAtom, (prev) => [...prev, item])
}

function updateItem(sessionId: string, itemId: string, patch: Partial<ConversationItem>): void {
  defaultCore.getSessionStore(sessionId).store.setter(itemsAtom, (prev) =>
    prev.map((it) => (it.id === itemId ? { ...it, ...patch } : it)),
  )
}

function createRenderer(): { sessionId: string; lines: string[]; dispose: () => void } {
  const sessionId = newSession()
  sessionIds.push(sessionId)
  const lines: string[] = []
  return {
    sessionId,
    lines,
    dispose: subscribeCliRenderer(sessionId, { write: (text) => lines.push(text) }),
  }
}

afterEach(() => {
  for (const sessionId of sessionIds.splice(0)) removeSession(sessionId)
})

describe('subscribeCliRenderer', () => {
  it('优先写入流式增量，并由完成态补上末尾换行而不重复回复', () => {
    const { sessionId, lines, dispose } = createRenderer()
    const initial = assistant('assistant-1', '流式')
    const complete = assistant('assistant-1', '流式回复', false)
    appendItem(sessionId, initial)
    setAssistantStream(sessionId, { runId: 'run-1', item: initial })
    setAssistantStream(sessionId, { runId: 'run-1', item: complete })
    updateItem(sessionId, initial.id, { pending: false, item: complete.item })
    dispose()

    expect(lines).toEqual(['[assistant] 流式', '回复', '\n'])
  })

  it('没有流快照时由 itemsAtom 的完成态完整输出助手回复', () => {
    const { sessionId, lines, dispose } = createRenderer()
    const item = assistant('assistant-2', '完整回复')
    appendItem(sessionId, item)
    updateItem(sessionId, item.id, { pending: false })
    dispose()

    expect(lines).toEqual(['[assistant] 完整回复\n'])
  })

  it('普通工具取既有事件面的名称，timed 调用从 callId 取真实名称', () => {
    const { sessionId, lines, dispose } = createRenderer()
    appendItem(sessionId, {
      id: 'tool-call-owner',
      createdAt: 1,
      item: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'plain-call', type: 'function', function: { name: 'skill_manifest', arguments: '{}' } }],
      },
    })
    appendItem(sessionId, {
      id: 'plain-result',
      createdAt: 2,
      item: { role: 'tool', tool_call_id: 'plain-call', content: '{}' },
    })
    appendItem(sessionId, {
      id: 'timed-result',
      createdAt: 3,
      item: { role: 'tool', tool_call_id: 'timed:sessionStart:skill_manifest', content: '{}' },
    })
    dispose()

    expect(lines).toEqual(['[tool] skill_manifest → ok\n', '[tool] skill_manifest → ok\n'])
  })
})
