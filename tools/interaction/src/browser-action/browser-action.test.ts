// browser-action.test.ts —— 副作用工具单测（TOOLS-SPEC §11）。
// 隔离红利：不需要 store，只 mock 一个 ctx，renderCard 用 vi.fn 可编程返回。
import { describe, it, expect, vi } from 'vitest'
import type { ToolContext } from '@einfach-agent/core/tools'
import { BROWSER_CARD_BODY_MAX_CHARS, browserActionTool } from './browser-action'

// 造一个 fake ctx：renderCard/saveArtifact 用 vi.fn，可按测试编程返回值。
function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
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
    // 默认成功返回一个 cardId；具体测试可覆盖。
    renderCard: vi.fn(() => ({ cardId: 'card-1' })),
    saveArtifact: vi.fn(() => ({ artifactId: 'art-1' })),
    ...overrides,
  }
}

describe('browser_action tool（agentNew · 经 ctx.renderCard，不碰 atom）', () => {
  it('合法 payload → ctx.renderCard 被以 {title,body} 调用，返回 {ok:true, data.cardId}', async () => {
    const renderCard = vi.fn(() => ({ cardId: 'card-42' }))
    const ctx = makeCtx({ renderCard })

    const result = await browserActionTool.execute(
      { action: 'render_card', payload: { title: '  标题  ', body: '正文' } },
      ctx,
    )

    // trim 后的 title + 保留的 body 一起传给 ctx.renderCard。
    expect(renderCard).toHaveBeenCalledWith({ title: '标题', body: '正文' })
    expect(result).toEqual({
      ok: true,
      data: {
        ok: true,
        cardId: 'card-42',
        note: '卡片不持久化，请在最终回复里文字概括其内容',
      },
    })
  })

  it('无 body 的合法 payload → renderCard 只收 {title}，仍 {ok:true}', async () => {
    const renderCard = vi.fn(() => ({ cardId: 'card-7' }))
    const ctx = makeCtx({ renderCard })

    const result = await browserActionTool.execute(
      { action: 'render_card', payload: { title: '只有标题' } },
      ctx,
    )

    expect(renderCard).toHaveBeenCalledWith({ title: '只有标题' })
    expect(result).toEqual({
      ok: true,
      data: {
        ok: true,
        cardId: 'card-7',
        note: '卡片不持久化，请在最终回复里文字概括其内容',
      },
    })
  })

  it('空字符串 body 不保留（只当非空 string 才带 body）', async () => {
    const renderCard = vi.fn(() => ({ cardId: 'card-8' }))
    const ctx = makeCtx({ renderCard })

    await browserActionTool.execute(
      { action: 'render_card', payload: { title: 't', body: '   ' } },
      ctx,
    )

    expect(renderCard).toHaveBeenCalledWith({ title: 't' })
  })

  it('renderCard 返回 {error:"stale"} → {ok:false, error:"stale"}', async () => {
    const renderCard = vi.fn(() => ({ error: 'stale' }))
    const ctx = makeCtx({ renderCard })

    const result = await browserActionTool.execute(
      { action: 'render_card', payload: { title: 't' } },
      ctx,
    )

    expect(result).toEqual({
      ok: false,
      error: 'stale',
      code: 'BROWSER_CARD_RENDER_FAILED',
      retryable: false,
    })
  })

  it('renderCard 抛错时返回可重试的结构化失败', async () => {
    const result = await browserActionTool.execute(
      { action: 'render_card', payload: { title: 't' } },
      makeCtx({ renderCard: vi.fn(() => { throw new Error('render bridge failed') }) }),
    )

    expect(result).toEqual({
      ok: false,
      error: 'render bridge failed',
      code: 'BROWSER_CARD_RENDER_FAILED',
      retryable: true,
    })
  })

  it('action 非 render_card → {ok:false}，且不调 renderCard', async () => {
    const renderCard = vi.fn(() => ({ cardId: 'x' }))
    const ctx = makeCtx({ renderCard })

    const result = await browserActionTool.execute(
      { action: 'click', payload: { title: 't' } },
      ctx,
    )

    expect(result).toEqual({
      ok: false,
      error: 'unsupported browser_action: click',
      code: 'BROWSER_ACTION_UNSUPPORTED',
      retryable: false,
    })
    expect(renderCard).not.toHaveBeenCalled()
  })

  it('title 空 → {ok:false}，且不调 renderCard', async () => {
    const renderCard = vi.fn(() => ({ cardId: 'x' }))
    const ctx = makeCtx({ renderCard })

    const result = await browserActionTool.execute(
      { action: 'render_card', payload: { title: '   ' } },
      ctx,
    )

    expect(result).toEqual({
      ok: false,
      error: 'invalid browser_action payload: title (non-empty string) is required',
      code: 'BROWSER_CARD_INVALID_INPUT',
      retryable: false,
    })
    expect(renderCard).not.toHaveBeenCalled()
  })

  it('拒绝超大卡片正文，不写入瞬态状态', async () => {
    const renderCard = vi.fn(() => ({ cardId: 'x' }))
    const result = await browserActionTool.execute({
      action: 'render_card',
      payload: { title: 't', body: 'x'.repeat(BROWSER_CARD_BODY_MAX_CHARS + 1) },
    }, makeCtx({ renderCard }))

    expect(result).toMatchObject({ ok: false, code: 'BROWSER_CARD_TOO_LARGE' })
    expect(renderCard).not.toHaveBeenCalled()
  })

  it('缺失 / 非对象 payload → title 校验失败 {ok:false}', async () => {
    const ctx = makeCtx()

    expect(await browserActionTool.execute({ action: 'render_card' }, ctx)).toEqual({
      ok: false,
      error: 'invalid browser_action payload: title (non-empty string) is required',
      code: 'BROWSER_CARD_INVALID_INPUT',
      retryable: false,
    })
  })

  it('是一个 browser runtime 工具，且带 skill 文档', () => {
    expect(browserActionTool.name).toBe('browser_action')
    expect(browserActionTool.runtime).toBe('browser')
    expect(typeof browserActionTool.skill.description).toBe('string')
    expect(browserActionTool.skill.content.length).toBeGreaterThan(0)
  })
})
