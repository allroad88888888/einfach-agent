import { describe, expect, it, vi } from 'vitest'
import type {
  PluginHookContext,
  PluginRunApi,
  PluginStateAccess,
  TurnEndEvent,
} from '@einfach-agent/core/plugin'
import { createStateAwareProbePlugin } from './stateAwareProbePlugin'

const TURN_END_EVENT: TurnEndEvent = {
  finishReason: 'stop',
  toolCalls: [],
  assistantHasContent: true,
  msg: undefined,
  hasStreamedItem: false,
}

type OnTurnEnd = (ctx: PluginHookContext, ev: TurnEndEvent) => void

/** Activates the plugin against a fake `PluginRunApi` and returns the hook it registered. */
function captureOnTurnEnd(plugin: ReturnType<typeof createStateAwareProbePlugin>): OnTurnEnd {
  let onTurnEnd: OnTurnEnd | undefined
  const api = {
    commands: { stopCurrentRun: () => false },
    observeRun: () => {},
    onAfterToolCall: () => {},
    hook: (name: string, fn: unknown) => {
      if (name === 'onTurnEnd') onTurnEnd = fn as OnTurnEnd
    },
  } as unknown as PluginRunApi
  plugin.activate?.(api)
  if (!onTurnEnd) throw new Error('expected the plugin to register onTurnEnd')
  return onTurnEnd
}

function fakeCtx(state: PluginStateAccess): PluginHookContext {
  return {
    sessionId: 's1',
    runId: 'r1',
    signal: new AbortController().signal,
    isCurrent: () => true,
    state,
  }
}

describe('createStateAwareProbePlugin', () => {
  it('reads the session item count and appends a note recording it', () => {
    const appendItem = vi.fn(() => 'item-99')
    const state: PluginStateAccess = {
      readSession: ((key: string) =>
        key === 'items'
          ? [{ id: 'a', createdAt: 1, item: { role: 'user', content: 'hi' } }]
          : undefined) as PluginStateAccess['readSession'],
      readRoot: (() => undefined) as PluginStateAccess['readRoot'],
      appendItem,
      setContextCheckpoint: () => true,
    }
    const outcomes: Array<string | undefined> = []
    const onTurnEnd = captureOnTurnEnd(
      createStateAwareProbePlugin({ onWriteOutcome: (id) => outcomes.push(id) }),
    )

    onTurnEnd(fakeCtx(state), TURN_END_EVENT)

    expect(appendItem).toHaveBeenCalledWith({
      role: 'system',
      content: 'state-aware-probe: turn ended with 1 item(s) in the session.',
    })
    expect(outcomes).toEqual(['item-99'])
  })

  it('treats a gated write (undefined) as a normal branch, not a throw', () => {
    const state: PluginStateAccess = {
      readSession: (() => []) as PluginStateAccess['readSession'],
      readRoot: (() => undefined) as PluginStateAccess['readRoot'],
      appendItem: () => undefined,
      setContextCheckpoint: () => true,
    }
    const outcomes: Array<string | undefined> = []
    const onTurnEnd = captureOnTurnEnd(
      createStateAwareProbePlugin({ onWriteOutcome: (id) => outcomes.push(id) }),
    )

    expect(() => onTurnEnd(fakeCtx(state), TURN_END_EVENT)).not.toThrow()
    expect(outcomes).toEqual([undefined])
  })
})
