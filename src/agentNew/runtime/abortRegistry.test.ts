import { describe, it, expect, afterEach } from 'vitest'
import {
  beginRun,
  abortRun,
  endRun,
  isRunning,
  resetAbortRegistry,
} from './abortRegistry'

// 每个用例后清空模块级注册表，保证单例 Map 在用例间互不污染。
afterEach(resetAbortRegistry)

describe('abortRegistry', () => {
  it('beginRun 返回未 abort 的 signal 并登记为运行中', () => {
    const signal = beginRun('a')

    expect(signal.aborted).toBe(false)
    expect(isRunning('a')).toBe(true)
  })

  it('对同一 id 再次 beginRun：旧 signal 被顶掉（aborted），新 signal 未 abort', () => {
    const s1 = beginRun('a')
    const s2 = beginRun('a')

    expect(s1.aborted).toBe(true)
    expect(s2.aborted).toBe(false)
    expect(isRunning('a')).toBe(true)
  })

  it('abortRun 触发 signal.aborted 并移出运行中', () => {
    const signal = beginRun('a')

    abortRun('a')

    expect(signal.aborted).toBe(true)
    expect(isRunning('a')).toBe(false)
  })

  it('abortRun 未知 id 为 no-op', () => {
    expect(() => abortRun('missing')).not.toThrow()
    expect(isRunning('missing')).toBe(false)
  })

  it('endRun 只删自己：被顶掉的旧 signal 不能清掉当前 run', () => {
    const s1 = beginRun('a')
    const s2 = beginRun('a') // 顶掉 s1

    // 用旧 signal 清理：当前 controller 是 s2，不应被删。
    endRun('a', s1)
    expect(isRunning('a')).toBe(true)

    // 用当前 signal 清理：正常删除。
    endRun('a', s2)
    expect(isRunning('a')).toBe(false)
  })

  it('resetAbortRegistry 清空所有登记', () => {
    beginRun('a')
    beginRun('b')

    resetAbortRegistry()

    expect(isRunning('a')).toBe(false)
    expect(isRunning('b')).toBe(false)
  })
})
