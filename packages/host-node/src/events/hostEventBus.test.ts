import { describe, expect, it, vi } from 'vitest'
import { createHostEventBus, type HostEventBus } from './hostEventBus'
import type { McpStdioClosePayload, McpStdioToolsChangedPayload } from './hostEventPayloads'

const TOOLS_CHANGED = 'mcp-stdio-tools-changed'
const CLOSE = 'mcp-stdio-close'

const toolsChanged: McpStdioToolsChangedPayload = { serverId: 'srv', sessionToken: 'tok' }
const closed: McpStdioClosePayload = { serverId: 'srv', sessionToken: 'tok', message: '子进程已退出' }

/** 收集报告出来的异常，顺便证明报告出口拿得到事件名。 */
function withReporter(): {
  bus: HostEventBus
  reported: Array<{ error: unknown, event: string }>
} {
  const reported: Array<{ error: unknown, event: string }> = []
  const bus = createHostEventBus({
    onHandlerError: (error, event) => {
      reported.push({ error, event })
    },
  })
  return { bus, reported }
}

describe('派发基本面', () => {
  it('订阅者收到载荷；CLI 这条路不序列化——handler 拿到的就是发射方那个对象', () => {
    const bus = createHostEventBus()
    const received: unknown[] = []
    bus.onHostEvent(CLOSE, (payload) => {
      received.push(payload)
    })
    bus.emitHostEvent(CLOSE, closed)
    // `toBe` 而不是 `toEqual`：这一条钉的正是判据里那句「CLI 进程内直接回调，无需序列化」。
    expect(received).toEqual([closed])
    expect(received[0]).toBe(closed)
  })

  it('事件之间互不串台', () => {
    const bus = createHostEventBus()
    const onClose = vi.fn()
    const onToolsChanged = vi.fn()
    bus.onHostEvent(CLOSE, onClose)
    bus.onHostEvent(TOOLS_CHANGED, onToolsChanged)
    bus.emitHostEvent(TOOLS_CHANGED, toolsChanged)
    expect(onToolsChanged).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('没有订阅者时发射不抛异常', () => {
    const bus = createHostEventBus()
    expect(() => bus.emitHostEvent(CLOSE, closed)).not.toThrow()
  })

  it('两个汇彼此独立——本域是工厂，不是模块级单例', () => {
    const first = createHostEventBus()
    const second = createHostEventBus()
    const handler = vi.fn()
    first.onHostEvent(CLOSE, handler)
    second.emitHostEvent(CLOSE, closed)
    expect(handler).not.toHaveBeenCalled()
  })

  it('多个订阅者按订阅顺序依次收到', () => {
    const bus = createHostEventBus()
    const order: string[] = []
    bus.onHostEvent(CLOSE, () => void order.push('first'))
    bus.onHostEvent(CLOSE, () => void order.push('second'))
    bus.emitHostEvent(CLOSE, closed)
    expect(order).toEqual(['first', 'second'])
  })
})

describe('取消订阅', () => {
  it('取消之后不再被调用', () => {
    const bus = createHostEventBus()
    const handler = vi.fn()
    const unsubscribe = bus.onHostEvent(CLOSE, handler)
    bus.emitHostEvent(CLOSE, closed)
    unsubscribe()
    bus.emitHostEvent(CLOSE, closed)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('派发中途取消**别人**的订阅：那个 handler 本次就不再被调用', () => {
    const bus = createHostEventBus()
    const later = vi.fn()
    bus.onHostEvent(CLOSE, () => {
      unsubscribeLater()
    })
    const unsubscribeLater = bus.onHostEvent(CLOSE, later)
    bus.emitHostEvent(CLOSE, closed)
    // 直接遍历原数组时这里会是 1（快照里还有它），只取快照不复查 active 时同样是 1。
    expect(later).not.toHaveBeenCalled()
  })

  it('派发中途取消**自己**的订阅：本次仍执行，之后不再被调用', () => {
    const bus = createHostEventBus()
    let calls = 0
    const unsubscribe: () => void = bus.onHostEvent(CLOSE, () => {
      calls += 1
      unsubscribe()
    })
    bus.emitHostEvent(CLOSE, closed)
    bus.emitHostEvent(CLOSE, closed)
    expect(calls).toBe(1)
  })

  it('派发中途取消前面那个订阅，不会让后面的 handler 被跳过', () => {
    // splice 直接改原数组、又用下标游标遍历时，这一条会红（游标跳过 middle 之后那个）。
    const bus = createHostEventBus()
    const seen: string[] = []
    const unsubscribeFirst: () => void = bus.onHostEvent(CLOSE, () => {
      seen.push('first')
      unsubscribeFirst()
    })
    bus.onHostEvent(CLOSE, () => void seen.push('middle'))
    bus.onHostEvent(CLOSE, () => void seen.push('last'))
    bus.emitHostEvent(CLOSE, closed)
    expect(seen).toEqual(['first', 'middle', 'last'])
  })

  it('派发中途新增的订阅不收本次事件，下一次才收', () => {
    const bus = createHostEventBus()
    const late = vi.fn()
    const unsubscribeSeed: () => void = bus.onHostEvent(CLOSE, () => {
      unsubscribeSeed()
      bus.onHostEvent(CLOSE, late)
    })
    bus.emitHostEvent(CLOSE, closed)
    expect(late).not.toHaveBeenCalled()
    bus.emitHostEvent(CLOSE, closed)
    expect(late).toHaveBeenCalledTimes(1)
  })

  it('重复取消是 no-op，且不会误伤同一个函数的另一条订阅', () => {
    const bus = createHostEventBus()
    const handler = vi.fn()
    const first = bus.onHostEvent(CLOSE, handler)
    bus.onHostEvent(CLOSE, handler)
    first()
    expect(() => {
      first()
      first()
    }).not.toThrow()
    bus.emitHostEvent(CLOSE, closed)
    // 第二条订阅必须还活着：按 handler 身份删就会在这里变成 0。
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('重复订阅同一个 handler', () => {
  it('算两条独立订阅，一次事件调用两次', () => {
    const bus = createHostEventBus()
    const handler = vi.fn()
    bus.onHostEvent(CLOSE, handler)
    bus.onHostEvent(CLOSE, handler)
    bus.emitHostEvent(CLOSE, closed)
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('两条订阅各自的取消函数互不影响', () => {
    const bus = createHostEventBus()
    const handler = vi.fn()
    const first = bus.onHostEvent(CLOSE, handler)
    const second = bus.onHostEvent(CLOSE, handler)
    first()
    bus.emitHostEvent(CLOSE, closed)
    expect(handler).toHaveBeenCalledTimes(1)
    second()
    bus.emitHostEvent(CLOSE, closed)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})

describe('handler 抛异常', () => {
  it('同步抛出：不影响其余 handler，异常带事件名报给出口', () => {
    const { bus, reported } = withReporter()
    const boom = new Error('handler 炸了')
    const after = vi.fn()
    bus.onHostEvent(CLOSE, () => {
      throw boom
    })
    bus.onHostEvent(CLOSE, after)
    expect(() => bus.emitHostEvent(CLOSE, closed)).not.toThrow()
    expect(after).toHaveBeenCalledTimes(1)
    expect(reported).toEqual([{ error: boom, event: CLOSE }])
  })

  it('返回的 Promise reject：同样被报告，且不会变成未处理的 rejection', async () => {
    // Node 从 v15 起默认把未处理的 rejection 当致命错误结束进程——一个 async handler 里的
    // await 失败就能把整个 CLI/server 带走。这一条钉的是「不能拖垮宿主」里最现实的那条路径。
    const { bus, reported } = withReporter()
    const boom = new Error('异步 handler 炸了')
    const after = vi.fn()
    bus.onHostEvent(CLOSE, async () => {
      await Promise.resolve()
      throw boom
    })
    bus.onHostEvent(CLOSE, after)
    bus.emitHostEvent(CLOSE, closed)
    expect(after).toHaveBeenCalledTimes(1)
    expect(reported).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reported).toEqual([{ error: boom, event: CLOSE }])
  })

  it('缺省报告出口是 console.error，不是静默吞掉', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bus = createHostEventBus()
    const boom = new Error('无出口时也要看得见')
    bus.onHostEvent(CLOSE, () => {
      throw boom
    })
    bus.emitHostEvent(CLOSE, closed)
    expect(consoleError).toHaveBeenCalledWith(boom)
  })

  it('报告出口自己抛异常时不打断派发', () => {
    const bus = createHostEventBus({
      onHandlerError: () => {
        throw new Error('报告出口也坏了')
      },
    })
    const after = vi.fn()
    bus.onHostEvent(CLOSE, () => {
      throw new Error('handler 炸了')
    })
    bus.onHostEvent(CLOSE, after)
    expect(() => bus.emitHostEvent(CLOSE, closed)).not.toThrow()
    expect(after).toHaveBeenCalledTimes(1)
  })
})

describe('名字与载荷的运行期守卫', () => {
  const looseBus = () => createHostEventBus() as unknown as {
    onHostEvent: (name: string, handler: (payload: unknown) => void) => () => void
    emitHostEvent: (name: string, payload: unknown) => void
  }

  it('订阅未知事件名当场抛，而不是留下一条永不触发的死订阅', () => {
    expect(() => looseBus().onHostEvent('mcp-stdio-clos', () => {})).toThrow(TypeError)
  })

  it('发射未知事件名当场抛', () => {
    expect(() => looseBus().emitHostEvent('mcp-stdio-clos', closed)).toThrow(TypeError)
  })

  it('载荷不合规时抛，且**一个 handler 都没被调用**（不存在半送达）', () => {
    const bus = looseBus()
    const handler = vi.fn()
    bus.onHostEvent(CLOSE, handler)
    expect(() => bus.emitHostEvent(CLOSE, { serverId: 'srv', at: new Date(0) })).toThrow(TypeError)
    expect(handler).not.toHaveBeenCalled()
  })
})
