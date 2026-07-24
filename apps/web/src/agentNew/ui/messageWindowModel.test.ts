import { createStore } from '@einfach/core'
import { describe, expect, it } from 'vitest'
import {
  EMPTY_MESSAGE_WINDOW,
  MESSAGE_WINDOW_SIZE,
  MESSAGE_WINDOW_STEP,
  compensateMessageScrollTop,
  latestMessageWindow,
  messageWindowAtom,
  moveMessageWindow,
  resolveMessageWindow,
} from './messageWindowModel'

describe('messageWindowModel', () => {
  it('长对话首次进入时只取最新窗口', () => {
    expect(resolveMessageWindow(EMPTY_MESSAGE_WINDOW, 500, true)).toEqual({
      start: 500 - MESSAGE_WINDOW_SIZE,
      end: 500,
      direction: 'idle',
    })
  })

  it('可以连续向前和向后移动，窗口大小保持不变', () => {
    const latest = latestMessageWindow(500)
    const backwardOnce = moveMessageWindow(latest, 'backward', 500)
    const backwardTwice = moveMessageWindow(backwardOnce, 'backward', 500)
    const forwardOnce = moveMessageWindow(backwardTwice, 'forward', 500)

    expect(backwardOnce.start).toBe(latest.start - MESSAGE_WINDOW_STEP)
    expect(backwardTwice.start).toBe(latest.start - MESSAGE_WINDOW_STEP * 2)
    expect(forwardOnce).toEqual({ ...backwardOnce, direction: 'forward' })
    expect(backwardOnce.end - backwardOnce.start).toBe(MESSAGE_WINDOW_SIZE)
  })

  it('到达两端后不再越界，并且每个 store 独立保存窗口', () => {
    let current = latestMessageWindow(130)
    for (let index = 0; index < 20; index += 1) {
      current = moveMessageWindow(current, 'backward', 130)
    }
    expect(current.start).toBe(0)
    expect(current.end).toBe(MESSAGE_WINDOW_SIZE)

    for (let index = 0; index < 20; index += 1) {
      current = moveMessageWindow(current, 'forward', 130)
    }
    expect(current).toEqual({
      start: 130 - MESSAGE_WINDOW_SIZE,
      end: 130,
      direction: 'forward',
    })

    const firstStore = createStore()
    const secondStore = createStore()
    firstStore.setter(messageWindowAtom, current)
    expect(firstStore.getter(messageWindowAtom)).toEqual(current)
    expect(secondStore.getter(messageWindowAtom)).toEqual(EMPTY_MESSAGE_WINDOW)
  })

  it('用更新前后的同一锚点补偿滚动位置', () => {
    expect(compensateMessageScrollTop(400, 120, 136)).toBe(416)
    expect(compensateMessageScrollTop(5, 120, 80)).toBe(0)
  })
})
