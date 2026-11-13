// 活性脉冲的派发语义 —— 四条断言各对应本仓踩过的一类坑
import { describe, expect, it, vi } from 'vitest'
import { createActivityPulse } from './activity'

describe('createActivityPulse', () => {
  it('touch 同步通知全部订阅方，按注册顺序', () => {
    const pulse = createActivityPulse()
    const seen: string[] = []
    pulse.listen(() => seen.push('a'))
    pulse.listen(() => seen.push('b'))

    pulse.touch()

    // 同步是硬要求：异步派发会留下「refresh 还没轮到、定时器已经触发」的窗口。
    expect(seen).toEqual(['a', 'b'])
  })

  it('取消后不再通知，重复取消是 no-op', () => {
    const pulse = createActivityPulse()
    const handler = vi.fn()
    const off = pulse.listen(handler)

    pulse.touch()
    off()
    off()
    pulse.touch()

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('派发中途取消订阅，被取消的那个不再收到本次事件', () => {
    // 防的是「只取快照、不复查 active」：被取消的仍在快照里，照样被调用一次，
    // 于是 onHostEvent 式的取消函数变成「有时管用」。
    const pulse = createActivityPulse()
    const seen: string[] = []
    let offSecond = (): void => {}
    pulse.listen(() => {
      seen.push('first')
      offSecond()
    })
    offSecond = pulse.listen(() => seen.push('second'))

    pulse.touch()

    expect(seen).toEqual(['first'])
  })

  it('同一个函数订阅两次算两条独立订阅，取消一条不影响另一条', () => {
    // 去重会让先调用的取消函数把另一条一并杀掉，而「两个消费方传同一个模块级函数」
    // 是常事。语义对齐 Node 的 EventEmitter。
    const pulse = createActivityPulse()
    const handler = vi.fn()
    const offFirst = pulse.listen(handler)
    pulse.listen(handler)

    pulse.touch()
    expect(handler).toHaveBeenCalledTimes(2)

    offFirst()
    pulse.touch()
    expect(handler).toHaveBeenCalledTimes(3)
  })
})
