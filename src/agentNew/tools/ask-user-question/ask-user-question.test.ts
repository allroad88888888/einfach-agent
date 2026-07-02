import { describe, it, expect, vi } from 'vitest'
import { askUserQuestionTool } from './ask-user-question'
import type { ToolContext } from '../types'

function makeCtx(): ToolContext {
  return {
    sessionId: 's',
    signal: new AbortController().signal,
    progress: vi.fn(),
    callTool: vi.fn(),
    runShell: vi.fn(async (input) => ({
      platform: input.platform,
      shell: 'test',
      command: input.command,
      cwd: input.cwd ?? '',
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 0,
      timedOut: false,
      truncated: false,
    })),
    renderCard: vi.fn(),
    saveArtifact: vi.fn(),
  }
}

describe('tools/ask-user-question/ask-user-question', () => {
  it('身份/runtime/skill 元数据齐备（含 content），required 含 id+questions', () => {
    expect(askUserQuestionTool.name).toBe('ask_user_question')
    expect(askUserQuestionTool.runtime).toBe('internal')
    expect(askUserQuestionTool.skill.description).toBeTruthy()
    expect(askUserQuestionTool.skill.content.length).toBeGreaterThan(0)
    expect(askUserQuestionTool.inputSchema).toMatchObject({ required: ['id', 'questions'] })
  })

  it('有 questions → { pause: 原 args }（暂停，§7）', async () => {
    const args = {
      id: 'q1',
      title: '确认范围',
      questions: [{ id: 'a', text: '要哪个方案？', type: 'single-choice', options: ['x', 'y'] }],
    }
    const result = await askUserQuestionTool.execute(args, makeCtx())

    expect(result).toMatchObject({ pause: args })
    if (!('pause' in result)) throw new Error('expected pause')
    expect(result.pause).toBe(args)
  })

  it('无 questions → { ok:false, error }', async () => {
    const result = await askUserQuestionTool.execute({ id: 'q1' }, makeCtx())
    expect(result).toMatchObject({ ok: false })
    if (!('ok' in result) || result.ok !== false) throw new Error('expected ok:false')
    expect(result.error).toBeTruthy()
  })

  it('空 questions 数组 → { ok:false, error }', async () => {
    const result = await askUserQuestionTool.execute({ id: 'q1', questions: [] }, makeCtx())
    expect(result).toMatchObject({ ok: false })
  })
})
