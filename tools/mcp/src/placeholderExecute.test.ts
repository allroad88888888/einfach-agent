// 透明连接 execute 的五步判据（蓝图第三节）：入口校验 → 状态复查 → 单飞连接 → reconcile →
// 委派。失败降级表（连接失败/超时/服务已删/工具已消失）的判据在 placeholderExecute.failure.test.ts。

import { describe, expect, it } from 'vitest'
import {
  RENAMED_TOOL_NAME,
  SERVER_ID,
  TOOL_NAME,
  placeholderContext,
  realTool,
  setupPlaceholderExecute,
} from './placeholderExecute.fixtures'

/** 手动控制何时连上：单飞与取消都要在「连接还在途中」那一刻做判断。 */
function gate() {
  let open = (): void => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open: () => open() }
}

describe('execute 五步 · 入口与状态复查', () => {
  it('① 入口校验由占位的透传 schema 完成：非对象参数在 registry 那一层就被挡下，一次连接都不发起', async () => {
    const wired = setupPlaceholderExecute()
    const { ctx } = placeholderContext()

    const result = await wired.call('not-an-object', ctx)

    expect(result).toMatchObject({ ok: false })
    // execute 因此不必自己再校验一遍 args 是不是对象——那条分支永远走不到，也就永远测不真。
    expect(wired.reconnect).not.toHaveBeenCalled()
  })

  it('② 状态复查：登记表里已经没有这条记录 → 不可重试的结构化错误，不连接、不回显连接目标', async () => {
    const wired = setupPlaceholderExecute({ removed: true })
    const { ctx } = placeholderContext()

    const result = await wired.call({ q: 'hello' }, ctx)

    expect(result).toMatchObject({
      ok: false,
      code: 'MCP_SERVER_NOT_CONFIGURED',
      retryable: false,
      details: { serverId: SERVER_ID, viaPlaceholder: true },
    })
    expect(wired.reconnect).not.toHaveBeenCalled()
    // 服务已经没了，回执里更不该出现它的命令行/地址——那是连接目标，绝不回显。
    expect(JSON.stringify(result)).not.toContain('npx')
  })

  it('② 状态复查：服务已连接 → 跳过连接直接委派（重连会把它的工具全注销再重建）', async () => {
    const wired = setupPlaceholderExecute({ status: 'connected' })
    const { ctx, progress } = placeholderContext()

    const result = await wired.call({ q: 'hello' }, ctx)

    expect(result).toMatchObject({ ok: true, data: { ranWith: { q: 'hello' } } })
    expect(wired.reconnect).not.toHaveBeenCalled()
    expect(progress).not.toHaveBeenCalled()
  })
})

describe('execute 五步 · ③ 单飞连接', () => {
  it('并发的第二个调用等的是同一条在途连接：reconnect 只发一次，先到的那条不会被拆掉', async () => {
    const opened = gate()
    const wired = setupPlaceholderExecute({
      connect: async (ctl) => {
        await opened.opened
        ctl.reconcile([realTool()])
      },
    })
    const first = placeholderContext()
    const second = placeholderContext()

    const a = wired.call({ q: 'a' }, first.ctx)
    const b = wired.call({ q: 'b' }, second.ctx)
    opened.open()
    const [resultA, resultB] = await Promise.all([a, b])

    // 第二次 reconnect 会先 abort 掉在途连接、再注销全部工具重建：先到的那次调用会被打断。
    expect(wired.reconnect).toHaveBeenCalledTimes(1)
    expect(resultA).toMatchObject({ ok: true, data: { ranWith: { q: 'a' } } })
    expect(resultB).toMatchObject({ ok: true, data: { ranWith: { q: 'b' } } })
  })

  it('单飞表用完即清：上一次连接已经结束时，下一次调用会重新连一次', async () => {
    const wired = setupPlaceholderExecute({
      connect: () => {
        throw new Error('connect refused')
      },
    })
    const { ctx } = placeholderContext()

    await wired.call({ q: 'a' }, ctx)
    await wired.call({ q: 'a' }, ctx)

    // 合并的只有【在途】的那一条；否则一次失败会把这个服务永久钉死在同一个结果上。
    expect(wired.reconnect).toHaveBeenCalledTimes(2)
  })
})

describe('execute 五步 · ④ reconcile 与 ⑤ 委派', () => {
  it('reconcile 由 manager 在连接成功路径内完成：委派到的是真实工具，不是占位自己', async () => {
    const wired = setupPlaceholderExecute()
    const { ctx, progress } = placeholderContext()

    const result = await wired.call({ q: 'hello' }, ctx)

    expect(result).toMatchObject({ ok: true, data: { ranWith: { q: 'hello' } } })
    // 真实工具原地覆盖了同名占位，占位登记随之作废——这正是与显式连接同一条路的结果。
    expect(wired.registry.has(TOOL_NAME, wired.placeholder)).toBe(false)
    expect(wired.claims.get(TOOL_NAME)).toBeUndefined()
    expect(wired.record()?.status).toBe('connected')
    expect(progress).toHaveBeenCalled()
  })

  it('委派走 registry.run 而不是 ctx.callTool，且不传 expectedRegistrationVersion', async () => {
    const wired = setupPlaceholderExecute()
    const { ctx, callTool } = placeholderContext()

    await wired.call({ q: 'hello' }, ctx)

    // ctx.callTool 的防环判据是 [...调用栈, 当前工具名].includes(目标名)，而占位与真实工具
    // 共用同一个名字：走 callTool 必然被判成 tool cycle。
    expect(callTool).not.toHaveBeenCalled()
    expect(wired.runSpy).toHaveBeenCalledTimes(2)
    const inner = wired.runSpy.mock.calls[1]
    expect(inner?.[0]).toBe(TOOL_NAME)
    expect(inner?.[1]).toEqual({ q: 'hello' })
    expect(inner?.[2]).toBe(ctx)
    // 外层执行器已按占位那一版做过一次原子校验；内层要执行的正是刚注册的新版本。
    expect(inner?.[3]).toBeUndefined()
  })

  it('第二段校验对着真实 schema：不通过时提示按下一轮下发的真实 schema 重试', async () => {
    const wired = setupPlaceholderExecute()
    const { ctx } = placeholderContext()

    // 占位的透传 schema 放行了这个参数（它只保证「是个对象」），真实 schema 不认。
    const result = await wired.call({ query: 'hello' }, ctx)

    expect(result).toMatchObject({ ok: false })
    const failure = result as { error: string; hint?: string; details?: unknown }
    expect(failure.error).toContain('q')
    expect(failure.hint).toContain('真实 schema')
    expect(failure.hint).toContain('下一轮')
    expect(failure.details).toMatchObject({ viaPlaceholder: true })
  })

  it('委派成功的回执原样返回：真实工具的结果不被占位改写', async () => {
    const wired = setupPlaceholderExecute()
    const { ctx } = placeholderContext()

    const result = await wired.call({ q: 'hello' }, ctx)

    expect(result).toEqual({ ok: true, data: { ranWith: { q: 'hello' } } })
  })
})

describe('取消是控制流，不是一条失败回执', () => {
  it('ctx.signal 已取消：抛 AbortError，绝不降级成 ToolResult', async () => {
    const wired = setupPlaceholderExecute()
    const { ctx, abort } = placeholderContext()
    abort()

    await expect(wired.call({ q: 'hello' }, ctx)).rejects.toMatchObject({ name: 'AbortError' })
    expect(wired.reconnect).not.toHaveBeenCalled()
  })

  it('等待连接期间被取消：同样抛 AbortError，而不是把它翻译成一次连接失败', async () => {
    const opened = gate()
    const wired = setupPlaceholderExecute({
      connect: async (ctl) => {
        await opened.opened
        ctl.reconcile([realTool()])
      },
    })
    const { ctx, abort } = placeholderContext()

    const pending = wired.call({ q: 'hello' }, ctx)
    abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    opened.open()
  })

  it('别人打断了共享的那条连接、而本次调用没被取消：按失败回执处理，不冒充取消', async () => {
    const wired = setupPlaceholderExecute({
      connect: () => {
        // manager 的下一次 connect/disconnect/remove 会 abort 掉在途连接，长这样。
        const error = new Error('The operation was aborted')
        error.name = 'AbortError'
        throw error
      },
    })
    const { ctx } = placeholderContext()

    const result = await wired.call({ q: 'hello' }, ctx)

    expect(result).toMatchObject({ ok: false, code: 'MCP_CONNECT_FAILED' })
  })
})

describe('远端清单与缓存不一致', () => {
  it('连接成功但真实清单里没有这个工具：附当前真实清单，写明原样重试无意义', async () => {
    const wired = setupPlaceholderExecute({
      connect: (ctl) => ctl.reconcile([realTool(RENAMED_TOOL_NAME)]),
    })
    const { ctx } = placeholderContext()

    const result = await wired.call({ q: 'hello' }, ctx)

    expect(result).toMatchObject({
      ok: false,
      code: 'MCP_TOOL_NOT_IN_SERVER',
      retryable: false,
      details: {
        serverId: SERVER_ID,
        status: 'connected',
        toolCount: 1,
        requestedTool: TOOL_NAME,
        viaPlaceholder: true,
      },
    })
    const failure = result as { hint?: string; details: { tools: { name: string }[] } }
    expect(failure.details.tools.map((tool) => tool.name)).toEqual([RENAMED_TOOL_NAME])
    expect(failure.hint).toContain('原样重试无意义')
  })

  it('连上之后这个名字仍被占位占着：绝不委派给自己（那会是一次无限递归）', async () => {
    const wired = setupPlaceholderExecute({
      // 只把记录标成 connected，registry 一个字不改：占位还在，真实工具没来。
      connect: (ctl) => ctl.markConnected(),
    })
    const { ctx } = placeholderContext()

    const result = await wired.call({ q: 'hello' }, ctx)

    expect(result).toMatchObject({ ok: false, code: 'MCP_TOOL_NOT_IN_SERVER' })
    expect(wired.reconnect).toHaveBeenCalledTimes(1)
  })
})
