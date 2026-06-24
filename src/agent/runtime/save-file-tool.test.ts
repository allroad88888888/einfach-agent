import { createStore } from '@einfach/core'
import { waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  activeMessagesAtom,
  activePendingArtifactsAtom,
  activeRunAtom,
  activeTimelineAtom,
} from '../state/atoms'
import { startAgentRun } from './loop'

// P2.1 / P2.4: drive `save_file` through the REAL lazy-tool path. The mock model
// adapter is triggered by the `save file` phrase and performs the two-stage
// protocol (request_tool_schema('save_file') -> submit save_file payload).
describe('save_file agent tool (lazy-tool real path)', () => {
  it('stages the artifact in pendingArtifacts and returns the readiness result without writing an assistant message', async () => {
    const store = createStore()

    startAgentRun(store, '帮我保存结果 save file demo')

    await waitFor(() => expect(store.getter(activeRunAtom)?.status).toBe('done'), {
      timeout: 8000,
    })

    // (1) artifact staged in pendingArtifactsAtom
    const artifacts = store.getter(activePendingArtifactsAtom)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({
      filename: 'plan.md',
      content: '# Plan\n\nstep 1',
      mimeType: 'text/markdown',
    })
    expect(typeof artifacts[0].id).toBe('string')

    // (3) timeline has a save_file tool event (call + done)
    const timeline = store.getter(activeTimelineAtom)
    const saveEvent = timeline.find((event) => event.title === 'call save_file')
    expect(saveEvent).toBeDefined()
    expect(saveEvent?.status).toBe('done')
    // (2) the result JSON (fed back to the model) carries the readiness message
    expect(saveEvent?.detail).toContain('保存按钮')

    // load schema event proves two-stage lazy-tool protocol was used
    expect(timeline.some((event) => event.title === 'load save_file')).toBe(true)

    // (4) the tool itself must NOT append an assistant message (§1.12). The run's
    // final assistant message comes from the model's next turn, not the tool.
    const messages = store.getter(activeMessagesAtom)
    const toolAuthoredAssistant = messages.find(
      (message) => message.role === 'assistant' && message.content.includes('已在界面提供保存按钮'),
    )
    expect(toolAuthoredAssistant).toBeUndefined()
    // last message is the model's deterministic answer, not the tool result
    expect(messages.at(-1)?.role).toBe('assistant')
  })

  it('PF5: accepts an empty-content file (content === "" is a valid payload)', async () => {
    const store = createStore()

    startAgentRun(store, '保存空文件 save empty file')

    await waitFor(() => expect(store.getter(activeRunAtom)?.status).toBe('done'), {
      timeout: 8000,
    })

    const artifacts = store.getter(activePendingArtifactsAtom)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({ filename: 'empty.txt', content: '' })

    const timeline = store.getter(activeTimelineAtom)
    const saveEvent = timeline.find((event) => event.title === 'call save_file')
    expect(saveEvent?.status).toBe('done')
    // not an error result
    expect(saveEvent?.detail).not.toContain('Invalid save_file payload')
  })
})
