import { describe, it, expect, vi } from 'vitest'
import { askUserQuestionTool } from './ask-user-question'
import type { ToolContext } from '@web-agent/core/tools'

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
  it('身份/runtime/skill 元数据齐备（含 content），required 只有 questions', () => {
    expect(askUserQuestionTool.name).toBe('ask_user_question')
    expect(askUserQuestionTool.runtime).toBe('internal')
    expect(askUserQuestionTool.skill.description).toBeTruthy()
    expect(askUserQuestionTool.skill.content.length).toBeGreaterThan(0)
    // 刻意只 required questions：其余交给 normalizeAskUserQuestionPayload 兜底，
    // 否则 registry.run() 的 schema 硬校验会抢在归一化层前面把整次提问打回，卡片不渲染。
    expect(askUserQuestionTool.inputSchema).toMatchObject({ required: ['questions'] })
  })

  // 回归：schema 不得比归一化层更严 —— 模型写歪 type / 漏 question 级 id 时，
  // 必须仍能走到 execute 拿到 { pause }，而不是在 registry 的 schema 校验阶段就被打回。
  it('question 级不设 required、type 不设 enum（硬校验全部让位给归一化层）', () => {
    const schema = askUserQuestionTool.inputSchema as {
      properties: {
        questions: {
          items: {
            required?: string[]
            properties: { type: { type?: string; enum?: unknown[]; description?: string } }
          }
        }
      }
    }
    const item = schema.properties.questions.items
    expect(item.required).toBeUndefined()
    expect(item.properties.type.enum).toBeUndefined()
    // 连 type 的类型约束都不设：归一化层对每个字段都有兜底，而 schema 层的任何硬校验都会让
    // 整次提问在 registry 就变成 { ok:false } → 不进 waiting_user → 提问卡片彻底不渲染。
    expect(item.properties.type.type).toBeUndefined()
    // 但取值范围仍要写给模型看（schema 会随 request_tool_schema 下发）。
    expect(item.properties.type.description).toContain('single-choice')
  })

  it('有 questions → 规范化后暂停（§7）', async () => {
    const args = {
      id: 'q1',
      title: '确认范围',
      questions: [{ id: 'a', text: '要哪个方案？', type: 'single-choice', options: ['x', 'y'] }],
    }
    const result = await askUserQuestionTool.execute(args, makeCtx())

    expect(result).toMatchObject({
      pause: {
        title: '确认范围',
        questions: [{ id: 'a', text: '要哪个方案？', type: 'single-choice', options: ['x', 'y'] }],
      },
    })
    if (!('pause' in result)) throw new Error('expected pause')
    expect(result.pause).not.toBe(args)
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

  it('原数组非空但全部问题无效时不暂停', async () => {
    const result = await askUserQuestionTool.execute(
      { questions: [{ id: '', text: 'missing id' }, null, { id: 'q', text: '' }] },
      makeCtx(),
    )
    expect(result).toMatchObject({ ok: false })
  })
})
