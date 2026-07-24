import { createStore } from '@einfach/core'
import { describe, expect, it } from 'vitest'
import {
  DEMO_MESSAGE_COUNT,
  DEMO_WINDOW_SIZE,
  compensateScrollTop,
  demoMessagesAtom,
  messageWindowAtom,
  moveWindow,
  shiftMessageWindowAtom,
  visibleDemoMessagesAtom,
} from './windowScrollModel'

describe('window scroll demo model', () => {
  it('只派生固定窗口，不复制或裁掉全量消息', () => {
    const store = createStore()

    expect(store.getter(demoMessagesAtom)).toHaveLength(DEMO_MESSAGE_COUNT)
    expect(store.getter(visibleDemoMessagesAtom)).toHaveLength(DEMO_WINDOW_SIZE)
  })

  it('向前和向后移动都保持固定窗口大小', () => {
    const current = { start: 200, end: 256, shifts: 0, direction: 'idle' as const }
    const forward = moveWindow(current, 'forward', DEMO_MESSAGE_COUNT)
    const backward = moveWindow(forward, 'backward', DEMO_MESSAGE_COUNT)

    expect(forward).toMatchObject({ start: 216, end: 272, shifts: 1, direction: 'forward' })
    expect(backward).toMatchObject({ start: 200, end: 256, shifts: 2, direction: 'backward' })
  })

  it('写 atom 移动窗口，visible atom 自动派生下一段', () => {
    const store = createStore()
    const before = store.getter(messageWindowAtom)

    store.setter(shiftMessageWindowAtom, 'forward')

    const after = store.getter(messageWindowAtom)
    const visible = store.getter(visibleDemoMessagesAtom)
    expect(after.start).toBe(before.start + 16)
    expect(visible[0].index).toBe(after.start)
    expect(visible.at(-1)?.index).toBe(after.end - 1)
  })

  it('用同一锚点更新前后的坐标差补偿 scrollTop', () => {
    expect(compensateScrollTop(900, 280, 120)).toBe(740)
    expect(compensateScrollTop(80, 100, 360)).toBe(340)
    expect(compensateScrollTop(20, 300, 0)).toBe(0)
  })
})
