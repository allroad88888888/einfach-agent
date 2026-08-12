import { describe, expect, it } from 'vitest'
import { abortError, raceWithAbort, throwIfAborted } from './internal'

describe('abortError', () => {
  it('无 reason 的 abort()：DOMException 的 name 是只读访问器，原样返回而不是抛 TypeError', () => {
    const controller = new AbortController()
    controller.abort()

    // 回归：这里曾对只读的 DOMException.name 赋值，在 strict 模式下把「取消」变成一次 TypeError。
    const error = abortError(controller.signal)
    expect(error.name).toBe('AbortError')
    expect(error).toBe(controller.signal.reason)
  })

  it('reason 是普通 Error：改名为 AbortError 并保留原实例与 message', () => {
    const controller = new AbortController()
    const reason = new Error('MCP connect timed out after 5ms')
    controller.abort(reason)

    const error = abortError(controller.signal)
    expect(error).toBe(reason)
    expect(error.name).toBe('AbortError')
    expect(error.message).toBe('MCP connect timed out after 5ms')
  })

  it('reason 的 name 改不动且不叫 AbortError（如 AbortSignal.timeout 的 TimeoutError）：包一层保住约定', () => {
    // 不直接 new DOMException：测试作用域里的 DOMException 与 jsdom AbortController 产出的
    // 不在同一个 realm，instanceof Error 会失真。用 getter-only 的 name 复现同一性质：
    // name 是只读访问器、值又不是 AbortError，赋值必抛，只能走包一层的分支。
    class TimeoutLikeError extends Error {
      override get name(): string {
        return 'TimeoutError'
      }
    }
    const controller = new AbortController()
    controller.abort(new TimeoutLikeError('signal timed out'))

    const error = abortError(controller.signal)
    expect(error.name).toBe('AbortError')
    expect(error.message).toBe('signal timed out')
  })

  it('没有 signal：给出兜底的 AbortError', () => {
    const error = abortError()
    expect(error.name).toBe('AbortError')
  })
})

describe('throwIfAborted / raceWithAbort 走同一条 abortError 路径', () => {
  it('throwIfAborted 对无 reason 的 abort() 抛 AbortError 而不是 TypeError', () => {
    const controller = new AbortController()
    controller.abort()
    expect(() => throwIfAborted(controller.signal)).toThrowError(
      expect.objectContaining({ name: 'AbortError' }),
    )
  })

  it('raceWithAbort 在等待中被无 reason abort：以 AbortError 拒绝', async () => {
    const controller = new AbortController()
    const pending = raceWithAbort(new Promise<never>(() => {}), controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
